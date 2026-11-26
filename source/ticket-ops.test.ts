// Ticket spaces over real checkouts: the folder's layout, what is generated
// into it, adding a repo, a plain space becoming one, and closing. idow is
// stood in for by what it does to the repo (a worktree where it is told to
// make one); git, the stores and the files are real.
import {test, expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {writeFiles} from '../test/helpers/config-fixtures.ts';
import {
	KEY,
	ticketFixture as fixture,
	worktreesOf,
} from '../test/helpers/ticket-fixture.ts';
import {git} from '../test/helpers/workdir-fixture.ts';
import {runTicketCloseHooks} from './close-space.ts';
import {resetRepoContexts} from './repo-context.ts';
import {
	addRepoToSpace,
	checkAddRepo,
	cleanTicketFolder,
	createTicketSpace,
	ticketRepoContexts,
	TicketError,
} from './ticket-ops.ts';
import {rejectionOf, thrownBy} from '../test/helpers/thrown.ts';

test('a ticket space is a folder of real worktrees, one per repo on the ticket’s branch', async () => {
	const t = fixture();
	const {ticket, warnings} = await createTicketSpace(t.env, {
		key: KEY,
		repos: [t.api.name, t.web.name],
	});
	expect(warnings).toEqual([]);
	expect(ticket.folder).toBe(t.folder);
	expect(ticket.repos).toEqual([
		{name: t.api.name, worktreePath: path.join(t.folder, t.api.name)},
		{name: t.web.name, worktreePath: path.join(t.folder, t.web.name)},
	]);
	for (const repo of [t.api, t.web]) {
		const worktree = path.join(t.folder, repo.name);
		// A real directory holding a worktree, never a link to one elsewhere.
		expect(fs.lstatSync(worktree).isDirectory()).toBe(true);
		expect(fs.lstatSync(worktree).isSymbolicLink()).toBe(false);
		expect(fs.lstatSync(path.join(worktree, '.git')).isFile()).toBe(true);
		expect(git(worktree, 'branch', '--show-current')).toBe(KEY);
		expect(worktreesOf(repo.root)).toContain(worktree);
	}

	expect(fs.readdirSync(t.folder).sort()).toEqual(
		['.claude', 'CLAUDE.md', t.api.name, t.web.name].sort(),
	);
	// The folder is no repository itself.
	expect(fs.existsSync(path.join(t.folder, '.git'))).toBe(false);
});

test("each repo's worktree is made by idow in that repo, and the lead agent by idow for the work dir", async () => {
	const t = fixture();
	await createTicketSpace(t.env, {
		key: KEY,
		repos: [t.api.name, t.web.name],
		profileName: 't',
		agentProfileName: 'codex',
	});
	expect(t.idow).toEqual([
		{
			repo: t.api.name,
			args: [
				'--worktree-only',
				path.join(t.folder, t.api.name),
				'--issue-key',
				KEY,
			],
		},
		{
			repo: t.web.name,
			args: [
				'--worktree-only',
				path.join(t.folder, t.web.name),
				'--issue-key',
				KEY,
			],
		},
		{
			repo: t.work.workRepo,
			args: ['--profile', 't', '--agent-profile', 'codex', '--issue-key', KEY],
		},
	]);
	expect(t.steps).toEqual([
		`worktree ${t.api.name}`,
		`worktree ${t.web.name}`,
		`lead ${KEY}`,
		`companions ${t.api.name},${t.web.name}`,
	]);
});

test("the ticket space is the work dir's own: registered there, with its repos on record", async () => {
	const t = fixture();
	await createTicketSpace(t.env, {key: KEY, repos: [t.api.name, t.web.name]});
	expect(t.own().registry.openSpaces()).toEqual([KEY]);
	// No repo lists it: it is one row on the rail, not one per repo.
	expect(t.daos(t.api.name).registry.has(KEY)).toBe(false);
	expect(t.daos(t.web.name).registry.has(KEY)).toBe(false);
	expect(t.env.tickets.read(KEY)?.repos.map(repo => repo.name)).toEqual([
		t.api.name,
		t.web.name,
	]);
	// Its worktree, as every store sees it, is the folder.
	const identity = t.own().spaceIdentities.get(KEY);
	expect(identity.kind === 'identity' && identity.identity.worktreePath).toBe(
		t.folder,
	);
	// A session standing in one of its repos is in the ticket space.
	const inside = t
		.own()
		.spaceIdentities.atPath(path.join(t.folder, t.api.name, 'src'));
	expect(inside.kind === 'identity' && inside.identity.key).toBe(KEY);
	expect(
		t.daos(t.api.name).spaceIdentities.atPath(path.join(t.folder, t.api.name))
			.kind,
	).toBe('unknown');
});

test('the generated CLAUDE.md lists the repos with their branches and PR rules, and repeats the work dir’s rules', async () => {
	const t = fixture();
	await createTicketSpace(t.env, {key: KEY, repos: [t.api.name, t.web.name]});
	const claudeMd = t.read('CLAUDE.md');
	expect(claudeMd).toContain(`# ${KEY}: Biz remittance credit`);
	expect(claudeMd).toContain('This is a **ticket folder**');
	const base = git(t.api.root, 'branch', '--show-current');
	expect(claudeMd).toContain(
		`| \`${t.api.name}/\` | ${t.api.name} | \`${KEY}\` | \`${base}\` |`,
	);
	expect(claudeMd).toContain(
		`PR template: \`${t.api.name}/.github/pull_request_template.md\``,
	);
	// The work dir's profile gives every repo its title format.
	expect(claudeMd).toContain('PR title format: `[KEY] Summary`.');
	expect(claudeMd).toContain(`Rules: \`${t.api.name}/CLAUDE.md\`.`);
	// web has no origin to name a default branch, and no rules of its own.
	expect(claudeMd).toContain('Default branch: not known');
	expect(claudeMd).toContain('this repo has no `CLAUDE.md`');
	expect(claudeMd).toContain(`not in this ticket: ${t.data.name}.`);
	// The work dir's rules, in the file itself.
	expect(claudeMd).toContain('Never push without asking.');
	expect(claudeMd).toContain(
		`[more](${path.join(t.work.work, 'docs/more.md')})`,
	);
	expect(claudeMd).not.toMatch(/(^|\s)@[.~/]/m);
});

test("the generated settings hold each repo's permissions and none of its hooks or env", async () => {
	const t = fixture();
	await createTicketSpace(t.env, {key: KEY, repos: [t.api.name, t.web.name]});
	expect(JSON.parse(t.read('.claude/settings.json'))).toEqual({
		permissions: {
			allow: ['Bash(./gradlew test:*)', 'Bash(yarn lint)'],
			deny: [`Read(./${t.api.name}/.env)`],
			ask: [],
		},
	});
});

/** `t`, with idow failing for the runs `fails` picks. */
function failing(
	t: ReturnType<typeof fixture>,
	fails: (repo: string, args: string[]) => boolean,
	stderr = 'Error: Failed to fetch issue B2B-123\n',
) {
	const original = t.env.runIdow;
	t.env.runIdow = async (args, repo) =>
		fails(repo.name, args)
			? {code: 1, stdout: '', stderr}
			: original(args, repo);
	return t;
}

test('a repo that cannot be set up stops the ticket space, which stays on the rail with the ones made', async () => {
	const broken = fixture();
	failing(broken, repo => repo === broken.web.name);
	const error = await rejectionOf(
		createTicketSpace(broken.env, {
			key: KEY,
			repos: [broken.api.name, broken.web.name],
		}),
	);
	expect(error).toBeInstanceOf(TicketError);
	expect((error as Error).message).toBe(
		`Could not set up ${broken.web.name} for ${KEY}: Error: Failed to fetch issue B2B-123. ${KEY} is on the rail with ${broken.api.name}, not started: select it to start its lead agent, or close it`,
	);
	expect(broken.env.tickets.read(KEY)?.repos.map(repo => repo.name)).toEqual([
		broken.api.name,
	]);
	// The worktree made is not left where nobody would find it again.
	expect(broken.own().registry.openSpaces()).toEqual([KEY]);
	expect(broken.read('CLAUDE.md')).toContain(`| \`${broken.api.name}/\` |`);
});

test('a ticket space that makes nothing leaves nothing: no folder, no record, no row', async () => {
	const broken = failing(fixture(), () => true);
	const error = await rejectionOf(
		createTicketSpace(broken.env, {
			key: KEY,
			repos: [broken.api.name, broken.web.name],
		}),
	);
	expect((error as Error).message).toBe(
		`Could not set up ${broken.api.name} for ${KEY}: Error: Failed to fetch issue B2B-123`,
	);
	expect(fs.existsSync(broken.folder)).toBe(false);
	expect(broken.env.tickets.read(KEY)).toBeUndefined();
	expect(broken.own().registry.has(KEY)).toBe(false);
});

test('a lead agent that cannot start leaves the ticket space on the rail, to start again or close', async () => {
	const t = failing(
		fixture(),
		(_repo, args) => !args.includes('--worktree-only'),
		'Error: initialization_command "/do" includes the skill prefix\n',
	);
	const error = await rejectionOf(
		createTicketSpace(t.env, {key: KEY, repos: [t.api.name, t.web.name]}),
	);
	expect((error as Error).message).toBe(
		`Could not start the lead agent of ${KEY}: Error: initialization_command "/do" includes the skill prefix. ${KEY} is on the rail with ${t.api.name} and ${t.web.name}, not started: select it to start its lead agent, or close it`,
	);
	// Both worktrees were made, and the space that holds them can be seen,
	// started and closed like any other.
	expect(worktreesOf(t.api.root)).toContain(path.join(t.folder, t.api.name));
	expect(worktreesOf(t.web.root)).toContain(path.join(t.folder, t.web.name));
	expect(t.own().registry.openSpaces()).toEqual([KEY]);
	const identity = t.own().spaceIdentities.get(KEY);
	expect(identity.kind === 'identity' && identity.identity.worktreePath).toBe(
		t.folder,
	);
	expect(t.env.tickets.read(KEY)?.repos.map(repo => repo.name)).toEqual([
		t.api.name,
		t.web.name,
	]);
	expect(t.read('CLAUDE.md')).toContain('This is a **ticket folder**');
});

/** The work dir's config with its top level replaced, its repos kept. */
function workdirConfig(t: ReturnType<typeof fixture>, top: string[]) {
	const file = path.join(t.work.work, '.lasagna', 'workdir.yml');
	const text = fs.readFileSync(file, 'utf8');
	fs.writeFileSync(
		file,
		['version: 1', ...top, text.slice(text.indexOf('repos:'))].join('\n'),
	);
	// The config is read through the repo's context, built once per process.
	resetRepoContexts();
	return file;
}

test('a work dir that cannot start a lead agent is refused before any worktree is made', async () => {
	const t = fixture();
	const file = workdirConfig(t, []);
	const refused = `The work dir's config (${file}) cannot start a ticket space's lead agent: profiles: required object field`;
	const created = await rejectionOf(
		createTicketSpace(t.env, {key: KEY, repos: [t.api.name, t.web.name]}),
	);
	expect(created).toBeInstanceOf(TicketError);
	expect((created as Error).message).toBe(refused);
	// A plain space is not converted either: its agent is still its own.
	const plain = await t.plainSpace(t.api, 'In api');
	const converted = await rejectionOf(
		addRepoToSpace(t.env, {key: KEY, repo: t.web.name}),
	);
	expect((converted as Error).message).toBe(refused);
	expect(t.idow).toEqual([]);
	expect(t.steps).toEqual([]);
	expect(fs.existsSync(t.folder)).toBe(false);
	expect(fs.existsSync(plain)).toBe(true);
	expect(t.daos(t.api.name).registry.has(KEY)).toBe(true);
});

test('a profile or agent profile the work dir does not have is refused before any worktree is made', async () => {
	const t = fixture();
	const message = async (options: {
		profileName?: string;
		agentProfileName?: string;
	}) =>
		(
			(await rejectionOf(
				createTicketSpace(t.env, {key: KEY, repos: [t.api.name], ...options}),
			)) as Error
		).message;
	expect(await message({profileName: 'nope'})).toBe(
		'The work dir has no profile nope. Its profiles: t',
	);
	expect(await message({agentProfileName: 'nope'})).toStartWith(
		'Unknown agent profile "nope".',
	);
	expect(t.idow).toEqual([]);
});

test('a directory in the ticket folder that is not the repo\u2019s worktree is not taken for it', async () => {
	const t = fixture();
	// Where api's worktree goes, another repo's is: what a folder shared with
	// another work dir's ticket of the same key would hold.
	const squatter = path.join(t.folder, t.api.name);
	git(t.web.root, 'worktree', 'add', '-q', '-b', 'other', squatter);
	const error = await rejectionOf(
		createTicketSpace(t.env, {key: KEY, repos: [t.api.name]}),
	);
	expect((error as Error).message).toBe(
		`${squatter} is already there and is not a worktree of ${t.api.name} (${t.api.root}). Move it away, then add ${t.api.name} again`,
	);
	expect(t.env.tickets.read(KEY)).toBeUndefined();
	expect(t.own().registry.has(KEY)).toBe(false);
	// A plain directory is no worktree of anything.
	const plain = fixture();
	fs.mkdirSync(path.join(plain.folder, plain.api.name), {recursive: true});
	expect(
		(
			(await rejectionOf(
				createTicketSpace(plain.env, {key: KEY, repos: [plain.api.name]}),
			)) as Error
		).message,
	).toContain(`is not a worktree of ${plain.api.name}`);
});

test('two repos added to a ticket at once are both in it', async () => {
	const t = fixture();
	await createTicketSpace(t.env, {key: KEY, repos: [t.api.name]});
	// A repo's setup takes a while, in which the other add would read the
	// ticket as it was.
	const original = t.env.runIdow;
	t.env.runIdow = async (args, repo) => {
		await delay(40);
		return original(args, repo);
	};

	const results = await Promise.all([
		addRepoToSpace(t.env, {key: KEY, repo: t.web.name}),
		addRepoToSpace(t.env, {key: KEY, repo: t.data.name}),
	]);
	expect(results.map(result => result.kind)).toEqual(['added', 'added']);
	expect(t.env.tickets.read(KEY)?.repos.map(repo => repo.name)).toEqual([
		t.api.name,
		t.web.name,
		t.data.name,
	]);
	const claudeMd = t.read('CLAUDE.md');
	for (const repo of [t.api, t.web, t.data])
		expect(claudeMd).toContain(`| \`${repo.name}/\` | ${repo.name} |`);
	// The second ran on what the first left, so it showed all three.
	expect(t.steps.at(-1)).toBe(
		`companions ${t.api.name},${t.web.name},${t.data.name}`,
	);
});

test('a plain space converted twice at once becomes one ticket space with both repos', async () => {
	const t = fixture();
	await t.plainSpace(t.api, 'In api');
	const original = t.env.runIdow;
	t.env.runIdow = async (args, repo) => {
		await delay(40);
		return original(args, repo);
	};

	const [first, second] = await Promise.all([
		addRepoToSpace(t.env, {key: KEY, repo: t.web.name}),
		addRepoToSpace(t.env, {key: KEY, repo: t.data.name}),
	]);
	// The second found a ticket space where the first had found a plain one.
	expect([first.kind, second.kind]).toEqual(['converted', 'added']);
	expect(t.env.tickets.read(KEY)?.repos).toEqual([
		{name: t.api.name, worktreePath: path.join(t.folder, t.api.name)},
		{name: t.web.name, worktreePath: path.join(t.folder, t.web.name)},
		{name: t.data.name, worktreePath: path.join(t.folder, t.data.name)},
	]);
	// One lead agent, and the plain agent ended once.
	expect(t.steps.filter(step => step.startsWith('lead'))).toHaveLength(1);
	expect(t.steps.filter(step => step.startsWith('end'))).toHaveLength(1);
});

test('adding a repo to a ticket space makes its worktree, rewrites the files and tells the lead agent', async () => {
	const t = fixture();
	await createTicketSpace(t.env, {key: KEY, repos: [t.api.name, t.web.name]});
	t.steps.length = 0;
	const result = await addRepoToSpace(t.env, {key: KEY, repo: t.data.name});
	expect(result.kind).toBe('added');
	expect(result.warnings).toEqual([]);
	const worktree = path.join(t.folder, t.data.name);
	expect(git(worktree, 'branch', '--show-current')).toBe(KEY);
	expect(result.ticket.repos.map(repo => repo.name)).toEqual([
		t.api.name,
		t.web.name,
		t.data.name,
	]);
	expect(t.env.tickets.read(KEY)).toEqual(result.ticket);
	expect(t.read('CLAUDE.md')).toContain(
		`| \`${t.data.name}/\` | ${t.data.name} | \`${KEY}\` |`,
	);
	expect(t.read('CLAUDE.md')).toContain(
		'Every repo of the work dir is already in this ticket.',
	);
	expect(t.steps).toEqual([
		`worktree ${t.data.name}`,
		`companions ${t.api.name},${t.web.name},${t.data.name}`,
	]);
	expect(t.told).toHaveLength(1);
	expect(t.told[0]!.key).toBe(KEY);
	expect(t.told[0]!.text).toContain(
		`The repo ${t.data.name} was added to this ticket. Its worktree is ./${t.data.name} on the branch ${KEY}.`,
	);

	const again = await rejectionOf(
		addRepoToSpace(t.env, {key: KEY, repo: t.data.name}),
	);
	expect((again as Error).message).toBe(`${t.data.name} is already in ${KEY}`);
});

test('a lead agent that could not be told is a warning, not a failure', async () => {
	const t = fixture();
	await createTicketSpace(t.env, {key: KEY, repos: [t.api.name, t.web.name]});
	t.env.tellLead = async () => 'no-session';
	const result = await addRepoToSpace(t.env, {key: KEY, repo: t.data.name});
	expect(result.warnings).toEqual([
		'The lead agent was not told (no-session): tell it yourself',
	]);
	expect(fs.existsSync(path.join(t.folder, t.data.name, '.git'))).toBe(true);
});

test('adding a second repo to a plain space makes it a ticket space, moving its worktree in after its agent has handed over', async () => {
	const t = fixture();
	const plain = await t.plainSpace(t.api, 'Biz remittance credit');
	// The plain agent's work: one commit, one change not committed.
	writeFiles(plain, {'src/new.ts': 'export const added = 1;\n'});
	git(plain, 'add', '-A');
	git(plain, 'commit', '-q', '-m', 'B2B-123 add the new module');
	fs.appendFileSync(path.join(plain, 'CLAUDE.md'), 'uncommitted line\n');
	await t.daos(t.api.name).spaceState.addPrLink(KEY, {
		host: 'github.com',
		project: 'acme/api',
		localBranch: KEY,
		remoteBranch: KEY,
		url: 'https://github.com/acme/api/pull/7',
		number: 7,
	});

	const result = await addRepoToSpace(t.env, {key: KEY, repo: t.web.name});
	expect(result.kind).toBe('converted');
	expect(result.warnings).toEqual([]);
	// The new repo's worktree first, then the plain agent is told, the lead
	// agent starts with the handoff, and only then do the plain agent's
	// sessions end and its worktree move.
	expect(t.steps).toEqual([
		`worktree ${t.web.name}`,
		`tell ${t.api.name}:${KEY}`,
		`lead ${KEY}`,
		`end ${t.api.name}:${KEY}`,
		`move ${t.api.name}`,
		`companions ${t.api.name},${t.web.name}`,
	]);
	expect(t.toldSpaces).toEqual([
		{
			space: `${t.api.name}:${KEY}`,
			text: `${KEY} is becoming a ticket space: ${t.web.name} was added to it. A lead agent is starting in ${t.folder} with a handoff of your last turns and your diff, and this session ends as soon as it is up. Stop here and start nothing new.`,
		},
	]);
	// Its worktree moved where the lead agent was told it would be.
	expect(t.told).toEqual([]);

	// The worktree is in the ticket folder, as git knows it, with its work.
	const moved = path.join(t.folder, t.api.name);
	expect(fs.existsSync(plain)).toBe(false);
	expect(worktreesOf(t.api.root)).toContain(moved);
	expect(worktreesOf(t.api.root)).not.toContain(plain);
	expect(git(moved, 'branch', '--show-current')).toBe(KEY);
	expect(git(moved, 'log', '-1', '--format=%s')).toBe(
		'B2B-123 add the new module',
	);
	expect(git(moved, 'status', '--short')).toBe('M CLAUDE.md');

	// The space's identity follows: the work dir's, in the folder, with the
	// repo's worktree at its new path, and no longer the repo's plain space.
	expect(t.daos(t.api.name).registry.has(KEY)).toBe(false);
	expect(t.own().registry.openSpaces()).toEqual([KEY]);
	expect(result.ticket.repos).toEqual([
		{name: t.api.name, worktreePath: moved},
		{name: t.web.name, worktreePath: path.join(t.folder, t.web.name)},
	]);
	expect(t.env.tickets.read(KEY)).toEqual(result.ticket);
	// What the plain space knew goes with it.
	expect(t.own().spaceState.read(KEY)?.issueTitle).toBe(
		'Biz remittance credit',
	);
	expect(
		t
			.own()
			.spaceState.read(KEY)
			?.prLinks?.map(link => link.number),
	).toEqual([7]);
});

test('the lead agent starts on a handoff: the issue, the plain agent’s last turns and its branch’s diff', async () => {
	const t = fixture();
	const plain = await t.plainSpace(t.api, 'Biz remittance credit');
	writeFiles(plain, {'src/new.ts': 'export const added = 1;\n'});
	git(plain, 'add', '-A');
	git(plain, 'commit', '-q', '-m', 'B2B-123 add the new module');
	fs.appendFileSync(path.join(plain, 'CLAUDE.md'), 'uncommitted line\n');
	await addRepoToSpace(t.env, {key: KEY, repo: t.web.name});

	const lead = t.idow.at(-1)!;
	expect(lead.repo).toBe(t.work.workRepo);
	// The prompt is an argument: idow's environment can outlive the run.
	expect(lead.args).toEqual([
		'--agent-prompt',
		expect.any(String),
		'--issue-key',
		KEY,
	]);
	const prompt = lead.args[1]!;
	expect(prompt).toContain(
		`You are the lead agent for ${KEY}, which now spans ${t.api.name}, ${t.web.name}.`,
	);
	expect(prompt).toContain('Read HANDOFF.md in this folder first');
	// Short enough for a command line: the handoff itself is in the file.
	expect(prompt.length).toBeLessThan(1000);

	const handoff = t.read('HANDOFF.md');
	expect(handoff).toContain(`# Handoff: ${KEY} from ${t.api.name}`);
	expect(handoff).toContain(`${KEY}: Biz remittance credit`);
	expect(handoff).toContain('user: expose the table');
	expect(handoff).toContain('assistant: staged it');
	// What the branch changed: the commit, and the change not committed.
	expect(handoff).toContain('B2B-123 add the new module');
	expect(handoff).toContain('+export const added = 1;');
	expect(handoff).toContain('+uncommitted line');
	expect(handoff).toContain('M CLAUDE.md');
	expect(t.read('CLAUDE.md')).toContain('`HANDOFF.md` in this folder');
});

test('the handoff is what the plain agent had done when it was told to stop, not when the add began', async () => {
	const t = fixture();
	const plain = await t.plainSpace(t.api, 'Biz remittance credit');
	// The new repo's setup takes minutes, in which the plain agent works on.
	const original = t.env.runIdow;
	t.env.runIdow = async (args, repo) => {
		if (args.includes('--worktree-only'))
			writeFiles(plain, {'src/late.ts': 'export const late = true;\n'});
		return original(args, repo);
	};

	// And up to the moment its sessions end.
	const end = t.env.endSessions;
	t.env.endSessions = async (repo, key) => {
		fs.appendFileSync(path.join(plain, 'CLAUDE.md'), 'its last line\n');
		return end(repo, key);
	};

	let atLeadStart = '';
	const idow = t.env.runIdow;
	t.env.runIdow = async (args, repo) => {
		if (!args.includes('--worktree-only')) atLeadStart = t.read('HANDOFF.md');
		return idow(args, repo);
	};

	await addRepoToSpace(t.env, {key: KEY, repo: t.web.name});
	// What the lead agent starts on has the work done during the setup.
	expect(atLeadStart).toContain('?? src/late.ts');
	expect(atLeadStart).not.toContain('+its last line');
	// What it reads once the plain agent has ended is all of it.
	expect(t.read('HANDOFF.md')).toContain('?? src/late.ts');
	expect(t.read('HANDOFF.md')).toContain('+its last line');
});

test('a lead agent that cannot start leaves the plain space as it was, and takes back what the add made', async () => {
	const t = failing(
		fixture(),
		(_repo, args) => !args.includes('--worktree-only'),
		'Error: Could not resolve the agent config for profile t\n',
	);
	const plain = await t.plainSpace(t.api, 'In api');
	const error = await rejectionOf(
		addRepoToSpace(t.env, {key: KEY, repo: t.web.name}),
	);
	expect(error).toBeInstanceOf(TicketError);
	expect((error as Error).message).toBe(
		`Could not start the lead agent of ${KEY}: Error: Could not resolve the agent config for profile t. ${KEY} stays a plain space in ${t.api.name}`,
	);
	// The plain space is untouched: open, in its own worktree, never ended.
	expect(fs.existsSync(plain)).toBe(true);
	expect(t.daos(t.api.name).registry.has(KEY)).toBe(true);
	expect(t.steps.filter(step => step.startsWith('end'))).toEqual([]);
	// Its agent, told it was being replaced, is told it is not.
	expect(t.toldSpaces.map(told => told.space)).toEqual([
		`${t.api.name}:${KEY}`,
		`${t.api.name}:${KEY}`,
	]);
	expect(t.toldSpaces[1]!.text).toStartWith(
		`The lead agent could not be started, so ${KEY} stays a plain space in ${t.api.name} and this session carries on:`,
	);
	// The worktree made for the new repo is gone, and so is the folder: no
	// ticket space, on the rail or off it.
	expect(worktreesOf(t.web.root)).toEqual([t.web.root]);
	expect(fs.existsSync(t.folder)).toBe(false);
	expect(t.env.tickets.read(KEY)).toBeUndefined();
	expect(t.own().registry.has(KEY)).toBe(false);
});

test('a worktree that cannot be moved stays where it was, on record and in the generated file', async () => {
	const t = fixture({failMove: true});
	const plain = await t.plainSpace(t.api, 'Biz remittance credit');
	const result = await addRepoToSpace(t.env, {key: KEY, repo: t.web.name});
	expect(result.warnings).toEqual([
		`${t.api.name}'s worktree stays at ${plain}: git worktree move failed (fatal: working trees containing submodules cannot be moved)`,
	]);
	expect(result.ticket.repos[0]).toEqual({
		name: t.api.name,
		worktreePath: plain,
	});
	expect(fs.existsSync(plain)).toBe(true);
	expect(t.read('CLAUDE.md')).toContain(`| \`${plain}\` | ${t.api.name} |`);
	// Its agent has ended, so it is the ticket's all the same.
	expect(t.daos(t.api.name).registry.has(KEY)).toBe(false);
	// The lead agent was started on ./api: it is told where the worktree is.
	expect(t.told).toEqual([
		{
			key: KEY,
			text: `${t.api.name}'s worktree stays at ${plain}: git worktree move failed (fatal: working trees containing submodules cannot be moved). Work on ${t.api.name} there, not under this folder: CLAUDE.md here was rewritten and gives the full path.`,
		},
	]);
	// Its rules are about where it is, not about a directory that is not there.
	expect(JSON.parse(t.read('.claude/settings.json')).permissions.deny).toEqual([
		`Read(/${plain}/.env)`,
	]);
});

test('a lead agent that cannot be told where a worktree stayed is a warning', async () => {
	const t = fixture({failMove: true});
	await t.plainSpace(t.api, 'Biz remittance credit');
	t.env.tellLead = async () => 'prompt';
	const result = await addRepoToSpace(t.env, {key: KEY, repo: t.web.name});
	expect(result.warnings.at(-1)).toBe(
		'The lead agent was not told (prompt): tell it yourself',
	);
});

test('a plain space whose sessions cannot be ended keeps its worktree and stays open', async () => {
	const t = fixture();
	const plain = await t.plainSpace(t.api, 'Biz remittance credit');
	t.env.endSessions = async () => false;
	const result = await addRepoToSpace(t.env, {key: KEY, repo: t.web.name});
	expect(result.warnings).toEqual([
		`${t.api.name}'s worktree stays at ${plain}: its sessions could not be ended`,
	]);
	expect(fs.existsSync(plain)).toBe(true);
	expect(t.daos(t.api.name).registry.has(KEY)).toBe(true);
	expect(t.told[0]!.text).toStartWith(
		`${t.api.name}'s worktree stays at ${plain}: its sessions could not be ended.`,
	);
});

test('a plain worktree is never moved into a directory that is already there', async () => {
	const t = fixture();
	const plain = await t.plainSpace(t.api, 'In api');
	// git would move it one level down, into the directory, as mv does.
	const taken = path.join(t.folder, t.api.name);
	fs.mkdirSync(taken, {recursive: true});
	const error = await rejectionOf(
		addRepoToSpace(t.env, {key: KEY, repo: t.web.name}),
	);
	expect((error as Error).message).toBe(
		`${taken} is already there, so the worktree of ${t.api.name}:${KEY} cannot move into the ticket folder. Move it away, then add ${t.web.name} again`,
	);
	// Refused before anything was made, started or ended.
	expect(t.steps).toEqual([]);
	expect(t.idow).toEqual([]);
	expect(fs.readdirSync(taken)).toEqual([]);
	expect(worktreesOf(t.api.root)).toContain(plain);
	expect(t.daos(t.api.name).registry.has(KEY)).toBe(true);
});

test('a directory that turns up where a worktree would move leaves the worktree where it is', async () => {
	const t = fixture();
	const plain = await t.plainSpace(t.api, 'In api');
	const taken = path.join(t.folder, t.api.name);
	// It appears once the conversion is under way: as its sessions end.
	t.env.endSessions = async () => {
		fs.mkdirSync(taken, {recursive: true});
		return true;
	};

	const result = await addRepoToSpace(t.env, {key: KEY, repo: t.web.name});
	expect(result.warnings).toEqual([
		`${t.api.name}'s worktree stays at ${plain}: ${taken} is already there`,
	]);
	expect(fs.readdirSync(taken)).toEqual([]);
	expect(worktreesOf(t.api.root)).toContain(plain);
	expect(result.ticket.repos[0]!.worktreePath).toBe(plain);
});

test('a plain space still being set up, or being closed, is not converted', async () => {
	const t = fixture();
	const plain = await t.plainSpace(t.api, 'In api');
	const {registry} = t.daos(t.api.name);
	// What a registry that records spaces while they start says of one.
	const phase = (name: 'starting' | 'closing') => {
		registry.phase = () => ({kind: 'phase', phase: name});
	};

	phase('starting');
	const starting = await rejectionOf(
		addRepoToSpace(t.env, {key: KEY, repo: t.web.name}),
	);
	expect((starting as Error).message).toBe(
		`${t.api.name}:${KEY} is still being set up. Add the repo once it has opened`,
	);
	phase('closing');
	const closing = await rejectionOf(
		addRepoToSpace(t.env, {key: KEY, repo: t.web.name}),
	);
	expect((closing as Error).message).toBe(
		`${t.api.name}:${KEY} is being closed`,
	);
	// Its worktree is where its own commands are running.
	expect(t.steps).toEqual([]);
	expect(t.idow).toEqual([]);
	expect(fs.existsSync(plain)).toBe(true);
});

test('the key open in two repos says which to name, and naming one converts that one', async () => {
	const t = fixture();
	await t.plainSpace(t.api, 'In api');
	await t.plainSpace(t.web, 'In web');
	const error = await rejectionOf(
		addRepoToSpace(t.env, {key: KEY, repo: t.data.name}),
	);
	expect((error as Error).message).toBe(
		`${KEY} is a space in more than one repo. Name one: ${t.api.name}:${KEY}, ${t.web.name}:${KEY}`,
	);

	// Adding one of the two to the other brings both plain spaces together.
	const result = await addRepoToSpace(t.env, {
		key: KEY,
		repo: t.web.name,
		from: t.api.name,
	});
	expect(result.kind).toBe('converted');
	expect(result.ticket.repos.map(repo => repo.name)).toEqual([
		t.api.name,
		t.web.name,
	]);
	expect(t.idow.map(run => run.repo)).toEqual([t.work.workRepo]);
	// Both agents are told, both end, and then both worktrees move.
	expect(t.steps).toEqual([
		`tell ${t.api.name}:${KEY}`,
		`tell ${t.web.name}:${KEY}`,
		`lead ${KEY}`,
		`end ${t.api.name}:${KEY}`,
		`end ${t.web.name}:${KEY}`,
		`move ${t.api.name}`,
		`move ${t.web.name}`,
		`companions ${t.api.name},${t.web.name}`,
	]);
	expect(t.read('HANDOFF.md')).toContain(
		`# Handoff: ${KEY} from ${t.web.name}`,
	);
	expect(t.daos(t.web.name).registry.has(KEY)).toBe(false);
	expect(git(path.join(t.folder, t.web.name), 'branch', '--show-current')).toBe(
		KEY,
	);
});

test('what cannot be added says why', async () => {
	const t = fixture();
	const message = async (options: Parameters<typeof addRepoToSpace>[1]) =>
		((await rejectionOf(addRepoToSpace(t.env, options))) as Error).message;
	expect(await message({key: KEY, repo: 'nope'})).toBe(
		`No repo nope in this work dir. Repos: ${t.api.name}, ${t.web.name}, ${t.data.name}`,
	);
	expect(await message({key: KEY, repo: t.web.name})).toBe(
		`No open space ${KEY} in this work dir`,
	);
	expect(await message({key: KEY, repo: t.web.name, from: t.api.name})).toBe(
		`No open space ${KEY} in ${t.api.name}`,
	);
	await t.plainSpace(t.api, 'In api');
	expect(await message({key: KEY, repo: t.api.name, from: t.api.name})).toBe(
		`${t.api.name} is already the repo of ${KEY}`,
	);
	// A ticket space is not made over a repo's open plain space.
	const error = await rejectionOf(
		createTicketSpace(t.env, {key: KEY, repos: [t.api.name, t.web.name]}),
	);
	expect((error as Error).message).toBe(
		`${KEY} is open as a plain space in ${t.api.name}. Add the other repos to it instead: lasagna space add-repo ${t.api.name}:${KEY} <repo>`,
	);
});

test("a ticket space takes over the worktree a repo's closed plain space left", async () => {
	const t = fixture();
	const plain = await t.plainSpace(t.api, 'In api');
	await t.daos(t.api.name).registry.remove(KEY);
	const {ticket} = await createTicketSpace(t.env, {
		key: KEY,
		repos: [t.api.name, t.web.name],
	});
	// Its branch is already checked out there, so that worktree is the one.
	expect(fs.existsSync(plain)).toBe(false);
	expect(ticket.repos[0]!.worktreePath).toBe(path.join(t.folder, t.api.name));
	expect(t.idow.map(run => run.repo)).toEqual([t.web.name, t.work.workRepo]);
});

test("closing runs each repo's deinit hooks in its own worktree, then removes only what was generated", async () => {
	const t = fixture();
	const {ticket} = await createTicketSpace(t.env, {
		key: KEY,
		repos: [t.api.name, t.web.name],
	});
	writeFiles(t.folder, {'notes.md': 'kept', 'HANDOFF.md': 'generated'});

	const outcome = await runTicketCloseHooks(
		{name: KEY, trackerIssue: null},
		ticketRepoContexts(t.env, ticket),
	);
	expect(outcome).toEqual({kind: 'ran'});
	expect(fs.readFileSync(t.marks, 'utf8').trim().split('\n')).toEqual([
		`${t.api.name} ${KEY} ${fs.realpathSync(path.join(t.folder, t.api.name))}`,
		`${t.web.name} ${KEY} ${fs.realpathSync(path.join(t.folder, t.web.name))}`,
	]);

	cleanTicketFolder(ticket);
	expect(fs.readdirSync(t.folder).sort()).toEqual(
		[t.api.name, t.web.name, 'notes.md'].sort(),
	);
	// The worktrees stay, as a closed plain space's does, and so does the
	// record of which repos the ticket is in.
	expect(worktreesOf(t.api.root)).toContain(path.join(t.folder, t.api.name));
	expect(t.env.tickets.read(KEY)).toEqual(ticket);
});

test('a ticket space closed earlier opens again with the repo added', async () => {
	const t = fixture();
	const {ticket} = await createTicketSpace(t.env, {
		key: KEY,
		repos: [t.api.name, t.web.name],
	});
	await t.own().registry.remove(KEY);
	cleanTicketFolder(ticket);
	t.idow.length = 0;

	const result = await addRepoToSpace(t.env, {key: KEY, repo: t.data.name});
	expect(result.kind).toBe('added');
	expect(result.ticket.repos.map(repo => repo.name)).toEqual([
		t.api.name,
		t.web.name,
		t.data.name,
	]);
	// Only the new repo needs a worktree; the lead agent starts again.
	expect(t.idow.map(run => run.repo)).toEqual([t.data.name, t.work.workRepo]);
	expect(t.own().registry.has(KEY)).toBe(true);
	expect(t.read('CLAUDE.md')).toContain(`| \`${t.data.name}/\` |`);
});

test('a ticket space closed earlier that cannot open again stays closed', async () => {
	const t = fixture();
	const {ticket} = await createTicketSpace(t.env, {
		key: KEY,
		repos: [t.api.name, t.web.name],
	});
	await t.own().registry.remove(KEY);
	cleanTicketFolder(ticket);
	failing(t, () => true);
	const error = await rejectionOf(
		addRepoToSpace(t.env, {key: KEY, repo: t.data.name}),
	);
	// Nothing was added to it, so it is as it was: closed, with its repos.
	expect((error as Error).message).toBe(
		`Could not set up ${t.data.name} for ${KEY}: Error: Failed to fetch issue B2B-123`,
	);
	expect(t.own().registry.has(KEY)).toBe(false);
	expect(t.env.tickets.read(KEY)).toEqual(ticket);
});

test('a plain space that joins a ticket closed earlier keeps the repos that ticket had', async () => {
	const t = fixture();
	const {ticket} = await createTicketSpace(t.env, {
		key: KEY,
		repos: [t.api.name, t.web.name],
	});
	await t.own().registry.remove(KEY);
	cleanTicketFolder(ticket);
	// The key comes up again in a third repo, as a plain space of its own.
	await t.plainSpace(t.data, 'In data');
	t.idow.length = 0;

	const result = await addRepoToSpace(t.env, {
		key: KEY,
		repo: t.api.name,
		from: t.data.name,
	});
	expect(result.kind).toBe('converted');
	// web was not named, and is still the ticket's: on record and in its file.
	expect(result.ticket.repos).toEqual([
		{name: t.api.name, worktreePath: path.join(t.folder, t.api.name)},
		{name: t.web.name, worktreePath: path.join(t.folder, t.web.name)},
		{name: t.data.name, worktreePath: path.join(t.folder, t.data.name)},
	]);
	expect(t.env.tickets.read(KEY)).toEqual(result.ticket);
	expect(t.read('CLAUDE.md')).toContain(
		`| \`${t.web.name}/\` | ${t.web.name} |`,
	);
	// api's worktree was there already: only the lead agent is started.
	expect(t.idow.map(run => run.repo)).toEqual([t.work.workRepo]);
	expect(t.idow[0]!.args[1]).toContain(
		`which now spans ${t.api.name}, ${t.web.name}, ${t.data.name}.`,
	);
});

test('what an add would do can be asked first: what it refuses, and whose plain space ends', async () => {
	const t = fixture();
	expect(
		thrownBy(() => checkAddRepo(t.env, {key: KEY, repo: 'nope'}), TicketError)
			.message,
	).toStartWith('No repo nope in this work dir.');
	await t.plainSpace(t.api, 'In api');
	await t.plainSpace(t.web, 'In web');
	// Converting api's with web: both plain spaces end.
	expect(
		checkAddRepo(t.env, {key: KEY, repo: t.web.name, from: t.api.name}),
	).toEqual({ending: [t.api.name, t.web.name]});
	expect(
		checkAddRepo(t.env, {key: KEY, repo: t.data.name, from: t.api.name}),
	).toEqual({ending: [t.api.name]});
	// Asking changed nothing.
	expect(t.steps).toEqual([]);
	expect(t.idow).toEqual([]);
	expect(fs.existsSync(t.folder)).toBe(false);
});
