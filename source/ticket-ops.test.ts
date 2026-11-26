// Ticket spaces over real checkouts: the folder's layout, what is generated
// into it, adding a repo, a plain space becoming one, and closing. idow is
// stood in for by what it does to the repo (a worktree where it is told to
// make one); git, the stores and the files are real.
import {test, expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {writeFiles} from '../test/helpers/config-fixtures.ts';
import {
	KEY,
	ticketFixture as fixture,
	worktreesOf,
} from '../test/helpers/ticket-fixture.ts';
import {git} from '../test/helpers/workdir-fixture.ts';
import {runTicketCloseHooks} from './close-space.ts';
import {
	addRepoToSpace,
	cleanTicketFolder,
	createTicketSpace,
	ticketRepoContexts,
	TicketError,
} from './ticket-ops.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';

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
			env: undefined,
		},
		{
			repo: t.web.name,
			args: [
				'--worktree-only',
				path.join(t.folder, t.web.name),
				'--issue-key',
				KEY,
			],
			env: undefined,
		},
		{
			repo: t.work.workRepo,
			args: ['--profile', 't', '--agent-profile', 'codex', '--issue-key', KEY],
			env: {LASAGNA_WORKDIR_REPO: t.work.workRepo},
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

test('a repo that cannot be set up stops the ticket space, and leaves the ones made on record', async () => {
	const broken = fixture();
	const original = broken.env.runIdow;
	broken.env.runIdow = async (args, repo, extraEnv) =>
		repo.name === broken.web.name
			? {code: 1, stdout: '', stderr: 'Error: Failed to fetch issue B2B-123\n'}
			: original(args, repo, extraEnv);
	const error = await rejectionOf(
		createTicketSpace(broken.env, {
			key: KEY,
			repos: [broken.api.name, broken.web.name],
		}),
	);
	expect(error).toBeInstanceOf(TicketError);
	expect((error as Error).message).toBe(
		`Could not set up ${broken.web.name} for ${KEY}: Error: Failed to fetch issue B2B-123`,
	);
	expect(broken.env.tickets.read(KEY)?.repos.map(repo => repo.name)).toEqual([
		broken.api.name,
	]);
	expect(broken.own().registry.has(KEY)).toBe(false);
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
	// The new repo's worktree first, the lead agent with the handoff next,
	// and only then do the plain agent's sessions end and its worktree move.
	expect(t.steps).toEqual([
		`worktree ${t.web.name}`,
		`lead ${KEY}`,
		`end ${t.api.name}:${KEY}`,
		`move ${t.api.name}`,
		`companions ${t.api.name},${t.web.name}`,
	]);

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
	expect(lead.args).toEqual(['--issue-key', KEY]);
	const prompt = lead.env!['LASAGNA_AGENT_PROMPT']!;
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
	expect(t.steps).toEqual([
		`lead ${KEY}`,
		`end ${t.api.name}:${KEY}`,
		`move ${t.api.name}`,
		`end ${t.web.name}:${KEY}`,
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
