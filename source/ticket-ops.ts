// Making and changing ticket spaces: a ticket folder with a worktree of each
// repo, the files generated into it, and the lead agent's session. The same
// steps run from the rail, from `lasagna space add-repo` and from the MCP
// tool, so everything outside this module that they need (idow, git, tmux,
// the stores) comes in as `TicketEnv`.

import fs from 'node:fs';
import path from 'node:path';
import type {RepoContext} from './repo-context.ts';
import type {SpaceIdentity} from './space-identity.ts';
import type {StateDaos} from './state-daos.ts';
import {
	readRepoSettings,
	mergeRepoSettings,
	removeTicketFiles,
	renderTicketClaudeMd,
	repoPrRules,
	TICKET_HANDOFF,
	unsharedModes,
	writeTicketFiles,
	type TicketRepoFacts,
} from './ticket-files.ts';
import {
	memberWorktree,
	ticketFolder,
	withTicketRepo,
	type Ticket,
	type TicketRepo,
	type TicketStore,
} from './ticket-space.ts';

export type TicketDaos = Pick<
	StateDaos,
	'registry' | 'spaceIdentities' | 'spaceState'
>;

export type IdowResult = {
	code: number | null;
	signal?: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

export type TicketEnv = {
	home: string;
	/** The work dir's pseudo-repo, which ticket spaces are spaces of. */
	workdir: RepoContext;
	/** The work dir's repos, in its order. */
	repos: () => RepoContext[];
	/** The stores of one of those repos, or of the work dir itself. */
	daos: (repo: string) => TicketDaos;
	tickets: TicketStore;
	/** Run idow for a repo: in its checkout, with its environment. */
	runIdow: (
		args: string[],
		repo: RepoContext,
		extraEnv?: Record<string, string>,
	) => Promise<IdowResult>;
	/** Run git in a directory, resolving with its output. */
	git: (cwd: string, args: string[]) => Promise<string>;
	/** Submit text to the lead agent of a ticket space; resolves with how it went. */
	tellLead: (key: string, text: string) => Promise<string>;
	/** End the agent and companion sessions of a repo's plain space. */
	endSessions: (repo: string, key: string) => Promise<boolean>;
	/** Start a companion pane for each of a ticket's repos that has none. */
	showCompanions: (ticket: Ticket) => void;
	/** The last turns of the agent that ran in a directory, as `read` prints them. */
	lastTurns: (worktreePath: string, key: string) => Promise<string | undefined>;
};

export class TicketError extends Error {}

function isDirectory(directory: string): boolean {
	try {
		return fs.statSync(directory).isDirectory();
	} catch {
		return false;
	}
}

function idowFailure(result: IdowResult): string {
	return (
		result.stderr.trim().split('\n').at(-1) ||
		/Error: .*/.exec(result.stdout)?.[0] ||
		`idow exited with ${result.signal ?? `code ${result.code}`}`
	);
}

function repoNamed(env: TicketEnv, name: string): RepoContext {
	const repo = env.repos().find(each => each.name === name);
	if (!repo)
		throw new TicketError(
			`No repo ${name} in this work dir. Repos: ${
				env
					.repos()
					.map(each => each.name)
					.join(', ') || '(none)'
			}`,
		);
	return repo;
}

/** Where a repo's plain space for the key has its worktree, when it has one. */
function plainWorktree(
	env: TicketEnv,
	repo: string,
	key: string,
): {identity: SpaceIdentity; open: boolean} | undefined {
	const daos = env.daos(repo);
	const lookup = daos.spaceIdentities.get(key);
	if (lookup.kind !== 'identity') return undefined;
	if (!isDirectory(lookup.identity.worktreePath)) return undefined;
	return {identity: lookup.identity, open: daos.registry.has(key)};
}

/**
 * Bring a repo's worktree for the key into the ticket folder: the one its
 * plain space left, moved, or a new one that idow makes there with the
 * repo's own setup commands.
 */
async function bringIn(
	env: TicketEnv,
	key: string,
	folder: string,
	repo: RepoContext,
): Promise<{member: TicketRepo; warning?: string}> {
	const worktreePath = memberWorktree(folder, repo.name);
	if (isDirectory(worktreePath))
		return {member: {name: repo.name, worktreePath}};
	const plain = plainWorktree(env, repo.name, key);
	if (plain) return moveIn(env, key, folder, repo, plain.identity);
	const result = await env.runIdow(
		['--worktree-only', worktreePath, '--issue-key', key],
		repo,
	);
	if (result.code !== 0)
		throw new TicketError(
			`Could not set up ${repo.name} for ${key}: ${idowFailure(result)}`,
		);
	return {member: {name: repo.name, worktreePath}};
}

/**
 * Move a plain space's worktree into the ticket folder. Its sessions are
 * ended first: moving the directory out from under a running agent leaves it
 * in a place that no longer exists.
 */
async function moveIn(
	env: TicketEnv,
	key: string,
	folder: string,
	repo: RepoContext,
	identity: SpaceIdentity,
): Promise<{member: TicketRepo; warning?: string}> {
	const worktreePath = memberWorktree(folder, repo.name);
	const stay = (reason: string) => ({
		member: {name: repo.name, worktreePath: identity.worktreePath},
		warning: `${repo.name}'s worktree stays at ${identity.worktreePath}: ${reason}`,
	});
	// With its agent still running the plain space stays what it was.
	if (!(await env.endSessions(repo.name, key)))
		return stay('its sessions could not be ended');
	// From here the plain space is the ticket's: one row, not two.
	await env.daos(repo.name).registry.remove(key);
	try {
		await env.git(repo.mainRoot, [
			'worktree',
			'move',
			identity.worktreePath,
			worktreePath,
		]);
	} catch (error) {
		return stay(
			`git worktree move failed (${error instanceof Error ? error.message.trim().split('\n').at(-1) : String(error)})`,
		);
	}

	return {member: {name: repo.name, worktreePath}};
}

async function defaultBranch(
	env: TicketEnv,
	mainRoot: string,
): Promise<string | undefined> {
	try {
		const head = await env.git(mainRoot, [
			'symbolic-ref',
			'--quiet',
			'--short',
			'refs/remotes/origin/HEAD',
		]);
		const name = head.trim().replace(/^origin\//, '');
		if (name) return name;
	} catch {
		// No origin/HEAD: fall back to the usual names.
	}

	for (const candidate of ['main', 'master']) {
		try {
			await env.git(mainRoot, [
				'show-ref',
				'--verify',
				'--quiet',
				`refs/remotes/origin/${candidate}`,
			]);
			return candidate;
		} catch {
			// Not this one.
		}
	}

	return undefined;
}

async function repoFacts(
	env: TicketEnv,
	key: string,
	member: TicketRepo,
): Promise<TicketRepoFacts | undefined> {
	const repo = env.repos().find(each => each.name === member.name);
	if (!repo) return undefined;
	let branch = key;
	try {
		const current = await env.git(member.worktreePath, [
			'branch',
			'--show-current',
		]);
		branch = current.trim() || key;
	} catch {
		// A worktree not there yet is on the ticket's branch once it is.
	}

	const base = await defaultBranch(env, repo.mainRoot);
	return {
		name: repo.name,
		worktreePath: member.worktreePath,
		mainRoot: repo.mainRoot,
		branch,
		...(base === undefined ? {} : {defaultBranch: base}),
		...repoPrRules(repo.readConfig(), repo.mainRoot),
		hasClaudeMd: fs.existsSync(path.join(repo.mainRoot, 'CLAUDE.md')),
	};
}

/** The work dir's own rules: its CLAUDE.md, at its root or under `.claude`. */
function workdirRules(root: string): {file: string; text: string} | undefined {
	for (const file of [
		path.join(root, 'CLAUDE.md'),
		path.join(root, '.claude', 'CLAUDE.md'),
	]) {
		try {
			const text = fs.readFileSync(file, 'utf8');
			if (text.trim()) return {file, text};
		} catch {
			// Try the next place.
		}
	}

	return undefined;
}

/**
 * Write the ticket folder's CLAUDE.md and settings from what its repos are
 * now. Called when the space is made and again whenever a repo is added.
 */
export async function writeTicketFolder(
	env: TicketEnv,
	ticket: Ticket,
): Promise<void> {
	const known = await Promise.all(
		ticket.repos.map(async member => repoFacts(env, ticket.key, member)),
	);
	const facts = known.flatMap(each => each ?? []);
	const names = new Set(ticket.repos.map(repo => repo.name));
	const rules = workdirRules(env.workdir.root);
	const settings = ticket.repos.map(member =>
		readRepoSettings(ticket.folder, member),
	);
	writeTicketFiles(ticket.folder, {
		claudeMd: renderTicketClaudeMd({
			key: ticket.key,
			title: env.daos(env.workdir.name).spaceState.read(ticket.key)?.issueTitle,
			folder: ticket.folder,
			workdir: {name: env.workdir.name.slice(1), root: env.workdir.root},
			repos: facts,
			otherRepos: env
				.repos()
				.map(repo => repo.name)
				.filter(name => !names.has(name)),
			...(rules === undefined ? {} : {rules}),
			hasHandoff: fs.existsSync(path.join(ticket.folder, TICKET_HANDOFF)),
			unsharedModes: unsharedModes(settings),
		}),
		settings: mergeRepoSettings(settings),
	});
}

/**
 * Start the lead agent's sessions in the ticket folder. idow does it, as it
 * does for any space: here the space is the work dir's own, so the agent, its
 * model and its first prompt come from the work dir's config.
 */
async function startLead(
	env: TicketEnv,
	key: string,
	options: {
		profileName?: string | null;
		agentProfileName?: string | null;
		prompt?: string;
	},
): Promise<void> {
	const result = await env.runIdow(
		[
			...(options.profileName ? ['--profile', options.profileName] : []),
			...(options.agentProfileName
				? ['--agent-profile', options.agentProfileName]
				: []),
			'--issue-key',
			key,
		],
		env.workdir,
		{
			LASAGNA_WORKDIR_REPO: env.workdir.name,
			...(options.prompt === undefined
				? {}
				: {LASAGNA_AGENT_PROMPT: options.prompt}),
		},
	);
	if (result.code !== 0)
		throw new TicketError(
			`Could not start the lead agent of ${key}: ${idowFailure(result)}`,
		);
	// idow holds a space it set up until its caller opens it.
	await env.daos(env.workdir.name).registry.add(key);
}

export type TicketResult = {
	ticket: Ticket;
	/** What did not go as asked but did not stop the ticket space. */
	warnings: string[];
};

/**
 * Make a ticket space for `key` in `repos`, or open it again: each repo's
 * worktree in the ticket folder, the generated files, and one lead agent
 * running in the folder.
 */
export async function createTicketSpace(
	env: TicketEnv,
	options: {
		key: string;
		repos: readonly string[];
		profileName?: string | null;
		agentProfileName?: string | null;
	},
): Promise<TicketResult> {
	const {key} = options;
	const known = env.tickets.read(key);
	const names = [
		...new Set([
			...(known?.repos.map(repo => repo.name) ?? []),
			...options.repos,
		]),
	];
	if (names.length === 0)
		throw new TicketError(`A ticket space needs a repo: ${key} was given none`);
	const repos = names.map(name => repoNamed(env, name));
	// A repo's open plain space for the key is running an agent in the
	// worktree this would move.
	const open = repos.filter(repo => env.daos(repo.name).registry.has(key));
	if (open.length > 0 && !env.daos(env.workdir.name).registry.has(key))
		throw new TicketError(
			`${key} is open as a plain space in ${open.map(repo => repo.name).join(' and ')}. Add the other repos to it instead: lasagna space add-repo ${open[0]!.name}:${key} <repo>`,
		);

	const folder = known?.folder ?? ticketFolder(env.home, env.workdir.name, key);
	fs.mkdirSync(folder, {recursive: true});
	let ticket: Ticket = {key, folder, repos: known?.repos ?? []};
	const warnings: string[] = [];
	for (const repo of repos) {
		const {member, warning} = await bringIn(env, key, folder, repo);
		if (warning) warnings.push(warning);
		ticket = withTicketRepo(ticket, member);
		// Recorded as it goes: a later repo that fails leaves the ones made.
		env.tickets.write(ticket);
	}

	await writeTicketFolder(env, ticket);
	await startLead(env, key, options);
	// idow recorded the issue's title, which the first write could not have.
	await writeTicketFolder(env, ticket);
	env.showCompanions(ticket);
	return {ticket, warnings};
}

/** How much of a branch's diff the handoff carries before pointing at git. */
const MAX_DIFF_CHARS = 60_000;

async function tryGit(
	env: TicketEnv,
	cwd: string,
	args: string[],
): Promise<string> {
	try {
		const output = await env.git(cwd, args);
		return output.trimEnd();
	} catch {
		return '';
	}
}

/**
 * What a plain space's agent leaves for the lead agent that takes over: the
 * issue, its last turns, and what its branch has changed so far.
 */
export async function buildHandoff(
	env: TicketEnv,
	options: {key: string; repo: RepoContext; worktreePath: string; dir: string},
): Promise<string> {
	const {key, repo, worktreePath, dir} = options;
	const title = env.daos(repo.name).spaceState.read(key)?.issueTitle;
	const base = await defaultBranch(env, repo.mainRoot);
	const mergeBase = base
		? await tryGit(env, worktreePath, [
				'merge-base',
				'HEAD',
				`refs/remotes/origin/${base}`,
			])
		: '';
	const from = mergeBase || 'HEAD';
	const commits = mergeBase
		? await tryGit(env, worktreePath, [
				'log',
				'--oneline',
				`${mergeBase}..HEAD`,
			])
		: '';
	const status = await tryGit(env, worktreePath, ['status', '--short']);
	const stat = await tryGit(env, worktreePath, ['diff', '--stat', from]);
	const diff = await tryGit(env, worktreePath, ['diff', from]);
	const turns = await env.lastTurns(worktreePath, key);
	const fenced = (text: string, language = '') =>
		['```' + language, text || '(nothing)', '```'].join('\n');
	return [
		`# Handoff: ${key} from ${repo.name}`,
		'',
		`Until now one agent worked on ${key} in ${repo.name} alone. The ticket now spans more repos, so a lead agent takes over in this folder. This file is what that agent leaves behind. Its worktree, with everything below in it, is \`${dir}/\`.`,
		'',
		'## Issue',
		'',
		`${key}${title ? `: ${title}` : ''}`,
		'',
		"## The agent's last turns",
		'',
		turns ? fenced(turns) : 'No conversation was recorded for it.',
		'',
		`## What its branch has changed`,
		'',
		mergeBase
			? `Against \`${base}\` (merge base \`${mergeBase.slice(0, 12)}\`), committed or not.`
			: 'Uncommitted changes only: the branch point could not be worked out.',
		'',
		'Commits:',
		'',
		fenced(commits),
		'',
		'`git status --short`:',
		'',
		fenced(status),
		'',
		fenced(stat),
		'',
		diff.length > MAX_DIFF_CHARS
			? `${fenced(diff.slice(0, MAX_DIFF_CHARS), 'diff')}\n\n(Cut here. See the rest with \`git -C ${dir} diff ${from.slice(0, 12)}\`.)`
			: fenced(diff, 'diff'),
		'',
	].join('\n');
}

function handoffPrompt(key: string, from: string[], added: string): string {
	const dirs = from.map(name => `./${name}`).join(' and ');
	return `You are the lead agent for ${key}, which now spans ${[...new Set([...from, added])].join(', ')}. Until now ${from.join(' and ')} had an agent of its own working on it; that work is in ${dirs}, which is moved into this folder as you start, so wait a moment if it is not there yet. Read ${TICKET_HANDOFF} in this folder first: it has the issue, that agent's last turns and its diff so far. Then carry on with ${key} across the repos. CLAUDE.md here says how this folder works.`;
}

export type AddRepoResult = TicketResult & {
	/** `added` to a ticket space that was there; `converted` from a plain space. */
	kind: 'added' | 'converted';
};

/**
 * Add a repo to the space `key`. A ticket space gains the repo's worktree
 * and its lead agent is told. A plain space, which has one repo, becomes a
 * ticket space: a lead agent starts in a new ticket folder with a handoff
 * from the plain space's agent, that agent's sessions end, and only then is
 * its worktree moved into the folder.
 */
export async function addRepoToSpace(
	env: TicketEnv,
	options: {
		key: string;
		repo: string;
		/** The plain space's repo, when the key is open in more than one. */
		from?: string;
	},
): Promise<AddRepoResult> {
	const {key} = options;
	const added = repoNamed(env, options.repo);
	const own = env.daos(env.workdir.name);
	const known = env.tickets.read(key);
	if (known && own.registry.has(key)) {
		if (known.repos.some(repo => repo.name === added.name))
			throw new TicketError(`${added.name} is already in ${key}`);
		const {member, warning} = await bringIn(env, key, known.folder, added);
		const ticket = withTicketRepo(known, member);
		env.tickets.write(ticket);
		await writeTicketFolder(env, ticket);
		env.showCompanions(ticket);
		const told = await env.tellLead(
			key,
			`The repo ${added.name} was added to this ticket. Its worktree is ./${path.relative(ticket.folder, member.worktreePath) || added.name} on the branch ${key}. CLAUDE.md in this folder was rewritten and lists it with its PR rules. Read its own CLAUDE.md before you change it.`,
		);
		return {
			kind: 'added',
			ticket,
			warnings: [
				...(warning ? [warning] : []),
				...(told === 'sent'
					? []
					: [`The lead agent was not told (${told}): tell it yourself`]),
			],
		};
	}

	// A plain space: the repos that have the key open, other than the new one.
	const plain = env
		.repos()
		.filter(
			repo =>
				repo.name !== added.name &&
				(options.from === undefined || repo.name === options.from) &&
				env.daos(repo.name).registry.has(key),
		);
	if (plain.length === 0) {
		if (options.from === added.name)
			throw new TicketError(`${added.name} is already the repo of ${key}`);
		// A ticket space closed earlier opens again with the repo added.
		if (known) {
			const reopened = await createTicketSpace(env, {
				key,
				repos: [added.name],
			});
			return {kind: 'added', ...reopened};
		}

		throw new TicketError(
			options.from === undefined
				? `No open space ${key} in this work dir`
				: `No open space ${key} in ${options.from}`,
		);
	}

	if (plain.length > 1)
		throw new TicketError(
			`${key} is a space in more than one repo. Name one: ${plain.map(repo => `${repo.name}:${key}`).join(', ')}`,
		);
	const [origin] = plain as [RepoContext];
	const from = plainWorktree(env, origin.name, key);
	if (!from)
		throw new TicketError(
			`${origin.name}:${key} has no worktree to move into a ticket folder`,
		);

	const folder = ticketFolder(env.home, env.workdir.name, key);
	fs.mkdirSync(folder, {recursive: true});
	const warnings: string[] = [];
	// The new repo may have a plain space of its own for the key. An open one
	// hands over too, and moves in with the first once the lead agent is up.
	const second = plainWorktree(env, added.name, key);
	const handing = [
		{repo: origin, identity: from.identity},
		...(second?.open ? [{repo: added, identity: second.identity}] : []),
	];
	const handoffs = await Promise.all(
		handing.map(async ({repo, identity}) =>
			buildHandoff(env, {
				key,
				repo,
				worktreePath: identity.worktreePath,
				dir: repo.name,
			}),
		),
	);
	fs.writeFileSync(
		path.join(folder, TICKET_HANDOFF),
		handoffs.join('\n---\n\n'),
	);

	let ticket: Ticket = {
		key,
		folder,
		// Where the plain worktrees will be once they have moved.
		repos: handing.map(({repo}) => ({
			name: repo.name,
			worktreePath: memberWorktree(folder, repo.name),
		})),
	};
	if (!second?.open) {
		const {member, warning} = await bringIn(env, key, folder, added);
		if (warning) warnings.push(warning);
		ticket = withTicketRepo(ticket, member);
	}

	env.tickets.write(ticket);
	// The ticket carries on what the plain space knew: its title and its PR.
	const state = env.daos(origin.name).spaceState.read(key);
	if (state?.issueTitle)
		await own.spaceState.write(key, {issueTitle: state.issueTitle});
	for (const {repo} of handing) {
		for (const link of env.daos(repo.name).spaceState.read(key)?.prLinks ?? [])
			await own.spaceState.addPrLink(key, link);
	}

	await writeTicketFolder(env, ticket);
	await startLead(env, key, {
		prompt: handoffPrompt(
			key,
			handing.map(({repo}) => repo.name),
			added.name,
		),
	});

	// The handoff is in the lead agent's hands: now the plain agents can end,
	// and only then do their worktrees move.
	for (const {repo, identity} of handing) {
		const {member, warning} = await moveIn(env, key, folder, repo, identity);
		if (warning) warnings.push(warning);
		ticket = withTicketRepo(ticket, member);
	}

	env.tickets.write(ticket);
	await writeTicketFolder(env, ticket);
	env.showCompanions(ticket);
	return {kind: 'converted', ticket, warnings};
}

/** The repos of a ticket with their contexts, for the hooks that close it. */
export function ticketRepoContexts(
	env: Pick<TicketEnv, 'repos'>,
	ticket: Ticket,
): Array<{repo: RepoContext; worktreePath: string}> {
	const repos = env.repos();
	return ticket.repos.flatMap(member => {
		const repo = repos.find(each => each.name === member.name);
		return repo ? [{repo, worktreePath: member.worktreePath}] : [];
	});
}

/**
 * What closing a ticket space leaves on disk: the repos' worktrees, as a
 * closed plain space leaves its own, and none of the generated files.
 */
export function cleanTicketFolder(ticket: Pick<Ticket, 'folder'>): void {
	removeTicketFiles(ticket.folder);
}
