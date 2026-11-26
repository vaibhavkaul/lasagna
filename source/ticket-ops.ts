// Making and changing ticket spaces: a ticket folder with a worktree of each
// repo, the files generated into it, and the lead agent's session. The same
// steps run from the rail, from `lasagna space add-repo` and from the MCP
// tool, so everything outside this module that they need (idow, git, tmux,
// the stores) comes in as `TicketEnv`.

import fs from 'node:fs';
import path from 'node:path';
import {checkAgentProfile, unknownAgentProfileMessage} from './config.ts';
import {inlineConfigErrors} from './config-errors.ts';
import {LockTimeoutError, withFileLock} from './file-lock.ts';
import {statusSocket} from './program-status-monitor.ts';
import {WORKDIR_CONFIG_FILE} from './repo-config-files.ts';
import type {RepoContext} from './repo-context.ts';
import {sameFile} from './same-file.ts';
import {newSpaceIdentity, type SpaceIdentity} from './space-identity.ts';
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
	runIdow: (args: string[], repo: RepoContext) => Promise<IdowResult>;
	/** Run git in a directory, resolving with its output. */
	git: (cwd: string, args: string[]) => Promise<string>;
	/** Submit text to the lead agent of a ticket space; resolves with how it went. */
	tellLead: (key: string, text: string) => Promise<string>;
	/** Submit text to the agent of a repo's plain space, the same way. */
	tellSpace: (repo: string, key: string, text: string) => Promise<string>;
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

/**
 * How long a change to a ticket waits for another process's change to the
 * same ticket: a repo's setup commands can take minutes.
 */
const TICKET_WAIT_MS = 15 * 60_000;

/**
 * One change to a ticket at a time, in this process and across the others
 * that change tickets (the rail, `space add-repo`, each agent's MCP server).
 * A change reads the ticket's record, makes a worktree for as long as the
 * repo's setup takes, and writes the record back: two at once would each
 * write what they had read, and the second would drop the first one's repo.
 */
async function changingTicket<T>(
	env: TicketEnv,
	key: string,
	change: () => Promise<T>,
): Promise<T> {
	try {
		return await withFileLock(
			env.tickets.file(key),
			change,
			undefined,
			TICKET_WAIT_MS,
		);
	} catch (error) {
		if (!(error instanceof LockTimeoutError)) throw error;
		throw new TicketError(
			`${key} is still being changed by another command. Try again when it is done`,
		);
	}
}

/**
 * Whether the work dir's config can start a lead agent, asked before any
 * worktree is made. idow, which starts it, refuses the same configs, and by
 * then every repo's setup has run for a space that cannot open.
 */
function checkLead(
	env: TicketEnv,
	options: {profileName?: string | null; agentProfileName?: string | null},
): void {
	const file = path.join(env.workdir.root, WORKDIR_CONFIG_FILE);
	const load = env.workdir.readConfig();
	if (load.kind === 'invalid')
		throw new TicketError(
			`The work dir's config (${file}) cannot start a ticket space's lead agent: ${inlineConfigErrors(load.errors)}`,
		);
	const profiles =
		load.kind === 'valid' ? Object.keys(load.config.profiles ?? {}) : [];
	if (load.kind !== 'valid' || profiles.length === 0)
		throw new TicketError(
			`A ticket space's lead agent is configured by the work dir itself, which has no profile. Add a top-level \`profiles\` entry to ${file}`,
		);
	if (options.profileName && !profiles.includes(options.profileName))
		throw new TicketError(
			`The work dir has no profile ${options.profileName}. Its profiles: ${profiles.join(', ')}`,
		);
	if (options.agentProfileName) {
		const check = checkAgentProfile(load.config, options.agentProfileName);
		if (check.kind !== 'known')
			throw new TicketError(
				unknownAgentProfileMessage(options.agentProfileName, check.names),
			);
	}
}

/**
 * Refuse a plain space that is still being set up or closed: its worktree is
 * not at rest, and moving it would pull it out from under its own setup
 * commands or its deinit hooks.
 */
function checkAtRest(env: TicketEnv, repo: string, key: string): void {
	const lookup = env.daos(repo).registry.phase(key);
	if (lookup.kind !== 'phase' || lookup.phase === 'open') return;
	throw new TicketError(
		lookup.phase === 'starting'
			? `${repo}:${key} is still being set up. Add the repo once it has opened`
			: `${repo}:${key} is being closed`,
	);
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

/** Whether a directory is a worktree of the repo, by the checkout it belongs to. */
async function isWorktreeOf(
	env: TicketEnv,
	repo: RepoContext,
	directory: string,
): Promise<boolean> {
	const commonDir = async (cwd: string) => {
		const output = await env.git(cwd, [
			'rev-parse',
			'--path-format=absolute',
			'--git-common-dir',
		]);
		return output.trim();
	};

	try {
		return sameFile(await commonDir(directory), await commonDir(repo.mainRoot));
	} catch {
		// No repository at all, or no git to ask.
		return false;
	}
}

type BroughtIn = {
	member: TicketRepo;
	warning?: string;
	/** Whether this run made the worktree, which nothing has worked in yet. */
	created?: boolean;
	/** Where the worktree was, when this run moved it in. */
	movedFrom?: string;
};

/** Remove a ticket folder that nothing is in. */
function removeIfEmpty(folder: string): void {
	try {
		fs.rmdirSync(folder);
	} catch {
		// Something is in it, or it was never made.
	}
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
): Promise<BroughtIn> {
	const worktreePath = memberWorktree(folder, repo.name);
	if (fs.existsSync(worktreePath)) {
		// What is there is the repo's worktree only if git says so: a folder
		// left by something else must not be worked in as if it were.
		if (!(await isWorktreeOf(env, repo, worktreePath)))
			throw new TicketError(
				`${worktreePath} is already there and is not a worktree of ${repo.name} (${repo.mainRoot}). Move it away, then add ${repo.name} again`,
			);
		return {member: {name: repo.name, worktreePath}};
	}

	const plain = plainWorktree(env, repo.name, key);
	if (plain) {
		if (plain.open) checkAtRest(env, repo.name, key);
		return moveIn(env, key, folder, repo, plain.identity);
	}

	const result = await env.runIdow(
		['--worktree-only', worktreePath, '--issue-key', key],
		repo,
	);
	if (result.code !== 0)
		throw new TicketError(
			`Could not set up ${repo.name} for ${key}: ${idowFailure(result)}`,
		);
	return {member: {name: repo.name, worktreePath}, created: true};
}

/** A plain space's worktree left where it is, and why. */
function stayAt(
	repo: RepoContext,
	identity: SpaceIdentity,
	reason: string,
): BroughtIn {
	return {
		member: {name: repo.name, worktreePath: identity.worktreePath},
		warning: `${repo.name}'s worktree stays at ${identity.worktreePath}: ${reason}`,
	};
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
): Promise<BroughtIn> {
	// With its agent still running the plain space stays what it was.
	if (!(await env.endSessions(repo.name, key)))
		return stayAt(repo, identity, 'its sessions could not be ended');
	return moveEnded(env, key, folder, repo, identity);
}

/** `moveIn`, for a plain space whose sessions have ended. */
async function moveEnded(
	env: TicketEnv,
	key: string,
	folder: string,
	repo: RepoContext,
	identity: SpaceIdentity,
): Promise<BroughtIn> {
	const worktreePath = memberWorktree(folder, repo.name);
	// From here the plain space is the ticket's: one row, not two.
	await env.daos(repo.name).registry.remove(key);
	// git moves a worktree into a directory that is there, as mv does: it
	// would end up one level down, where nothing looks for it.
	if (fs.existsSync(worktreePath))
		return stayAt(repo, identity, `${worktreePath} is already there`);
	try {
		await env.git(repo.mainRoot, [
			'worktree',
			'move',
			identity.worktreePath,
			worktreePath,
		]);
	} catch (error) {
		return stayAt(
			repo,
			identity,
			`git worktree move failed (${error instanceof Error ? error.message.trim().split('\n').at(-1) : String(error)})`,
		);
	}

	return {
		member: {name: repo.name, worktreePath},
		movedFrom: identity.worktreePath,
	};
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
 * model and its first prompt come from the work dir's config. `prompt` is
 * the agent's first prompt in place of the issue: a handoff.
 *
 * Both reach idow as arguments. Its environment becomes the tmux server's
 * when its session is the first on that server, and every later pane's from
 * there, where an idow run for a repo would take itself for the work dir's.
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
			...(options.prompt === undefined
				? []
				: ['--agent-prompt', options.prompt]),
			...(options.profileName ? ['--profile', options.profileName] : []),
			...(options.agentProfileName
				? ['--agent-profile', options.agentProfileName]
				: []),
			'--issue-key',
			key,
		],
		env.workdir,
	);
	if (result.code !== 0)
		throw new TicketError(
			`Could not start the lead agent of ${key}: ${idowFailure(result)}`,
		);
	// idow holds a space it set up until its caller opens it.
	await env.daos(env.workdir.name).registry.add(key);
}

/**
 * Put a ticket space whose start failed part-way on the rail all the same,
 * with the repos it has: their worktrees are made, and out of sight nobody
 * would close them or find them again. Selecting it there starts its lead
 * agent; closing it runs each repo's deinit hooks. Resolves with a sentence
 * saying so.
 */
async function keepOnRail(env: TicketEnv, ticket: Ticket): Promise<string> {
	const own = env.daos(env.workdir.name);
	// A registered key always has an identity. One idow got to record stays.
	await own.spaceIdentities.record(
		newSpaceIdentity({
			repo: env.workdir.name,
			key: ticket.key,
			worktreePath: ticket.folder,
			socket: statusSocket(),
		}),
	);
	await own.registry.add(ticket.key);
	await writeTicketFolder(env, ticket);
	return `${ticket.key} is on the rail with ${ticket.repos.map(repo => repo.name).join(' and ')}, not started: select it to start its lead agent, or close it`;
}

export type TicketResult = {
	ticket: Ticket;
	/** What did not go as asked but did not stop the ticket space. */
	warnings: string[];
};

type NewTicket = {
	key: string;
	repos: readonly string[];
	profileName?: string | null;
	agentProfileName?: string | null;
};

/**
 * Make a ticket space for `key` in `repos`, or open it again: each repo's
 * worktree in the ticket folder, the generated files, and one lead agent
 * running in the folder.
 */
export async function createTicketSpace(
	env: TicketEnv,
	options: NewTicket,
): Promise<TicketResult> {
	return changingTicket(env, options.key, async () =>
		makeTicketSpace(env, options),
	);
}

/**
 * What a ticket space for the key would be made of, or why it cannot be
 * made: the ticket closed earlier under the key, and the repos it would
 * hold. Nothing is changed.
 */
function planTicketSpace(
	env: TicketEnv,
	options: NewTicket,
): {known: Ticket | undefined; repos: RepoContext[]} {
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

	checkLead(env, options);
	return {known, repos};
}

/** `createTicketSpace`, for a caller that is already the one changing the ticket. */
async function makeTicketSpace(
	env: TicketEnv,
	options: NewTicket,
): Promise<TicketResult> {
	const {key} = options;
	const {known, repos} = planTicketSpace(env, options);
	const folder = known?.folder ?? ticketFolder(env.home, env.workdir.name, key);
	fs.mkdirSync(folder, {recursive: true});
	let ticket: Ticket = {key, folder, repos: known?.repos ?? []};
	const warnings: string[] = [];
	// Whether this run has put a worktree in the folder that was not the
	// ticket's before.
	let grown = false;
	try {
		for (const repo of repos) {
			const {member, warning} = await bringIn(env, key, folder, repo);
			if (warning) warnings.push(warning);
			grown ||= !ticket.repos.some(each => each.name === member.name);
			ticket = withTicketRepo(ticket, member);
			// Recorded as it goes: a later repo that fails leaves the ones made.
			env.tickets.write(ticket);
		}

		await writeTicketFolder(env, ticket);
		await startLead(env, key, options);
	} catch (error) {
		if (!grown) {
			// As it was before: a ticket closed earlier stays closed, and a new
			// one that got nowhere leaves no folder.
			if (!known) removeIfEmpty(folder);
			throw error;
		}

		// Whatever stopped it, what was made is not left out of sight. If that
		// cannot be done either, the first failure is the one to report.
		const kept = await keepOnRail(env, ticket).catch(() => undefined);
		if (!(error instanceof TicketError) || kept === undefined) throw error;
		throw new TicketError(`${error.message}. ${kept}`);
	}

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

function handoffPrompt(key: string, from: string[], repos: string[]): string {
	const dirs = from.map(name => `./${name}`).join(' and ');
	return `You are the lead agent for ${key}, which now spans ${repos.join(', ')}. Until now ${from.join(' and ')} had an agent of its own working on it; that work is in ${dirs}, which is moved into this folder as you start, so wait a moment if it is not there yet. Read ${TICKET_HANDOFF} in this folder first: it has the issue, that agent's last turns and its diff so far. Then carry on with ${key} across the repos. CLAUDE.md here says how this folder works.`;
}

export type AddRepoResult = TicketResult & {
	/** `added` to a ticket space that was there; `converted` from a plain space. */
	kind: 'added' | 'converted';
};

type AddRepoOptions = {
	key: string;
	repo: string;
	/** The plain space's repo, when the key is open in more than one. */
	from?: string;
};

/** A plain space that hands over to a lead agent: its repo and where it works. */
type Handing = {repo: RepoContext; identity: SpaceIdentity};

type AddRepoPlan =
	| {kind: 'add'; added: RepoContext; known: Ticket}
	| {kind: 'reopen'; added: RepoContext}
	| {
			kind: 'convert';
			added: RepoContext;
			/** The ticket closed earlier under this key, whose repos come along. */
			known: Ticket | undefined;
			folder: string;
			/** The plain spaces that end: the one named, and the new repo's own if it has one open. */
			handing: Handing[];
	  };

/**
 * What adding the repo to the space would do, or why it cannot be done.
 * Nothing is changed: everything that can be refused is refused here, before
 * a worktree is made or a session ends.
 */
function planAddRepo(env: TicketEnv, options: AddRepoOptions): AddRepoPlan {
	const {key} = options;
	const added = repoNamed(env, options.repo);
	const own = env.daos(env.workdir.name);
	const known = env.tickets.read(key);
	// The new repo's own plain space for the key, whose worktree moves in.
	const second = plainWorktree(env, added.name, key);
	if (known && own.registry.has(key)) {
		if (known.repos.some(repo => repo.name === added.name))
			throw new TicketError(`${added.name} is already in ${key}`);
		if (second?.open) checkAtRest(env, added.name, key);
		return {kind: 'add', added, known};
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
			planTicketSpace(env, {key, repos: [added.name]});
			return {kind: 'reopen', added};
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
	checkAtRest(env, origin.name, key);
	const from = plainWorktree(env, origin.name, key);
	if (!from)
		throw new TicketError(
			`${origin.name}:${key} has no worktree to move into a ticket folder`,
		);
	// An open plain space of the new repo hands over too, and moves in with
	// the first once the lead agent is up.
	if (second?.open) checkAtRest(env, added.name, key);
	const handing = [
		{repo: origin, identity: from.identity},
		...(second?.open ? [{repo: added, identity: second.identity}] : []),
	];
	checkLead(env, {});
	const folder = known?.folder ?? ticketFolder(env.home, env.workdir.name, key);
	for (const {repo} of handing) {
		const destination = memberWorktree(folder, repo.name);
		if (fs.existsSync(destination))
			throw new TicketError(
				`${destination} is already there, so the worktree of ${repo.name}:${key} cannot move into the ticket folder. Move it away, then add ${added.name} again`,
			);
	}

	return {kind: 'convert', added, known, folder, handing};
}

/**
 * Why the repo cannot be added to the space, as `addRepoToSpace` would say
 * it, for a caller that has to know before it starts: throws a TicketError,
 * and changes nothing. Resolves with the repos whose plain space for the key
 * would end, the one that is converted first.
 */
export function checkAddRepo(
	env: TicketEnv,
	options: AddRepoOptions,
): {ending: string[]} {
	const plan = planAddRepo(env, options);
	if (plan.kind === 'convert')
		return {ending: plan.handing.map(({repo}) => repo.name)};
	// The new repo's own plain space, open or closed, gives up its worktree.
	return {
		ending: plainWorktree(env, plan.added.name, options.key)
			? [plan.added.name]
			: [],
	};
}

/**
 * Add a repo to the space `key`. A ticket space gains the repo's worktree
 * and its lead agent is told. A plain space, which has one repo, becomes a
 * ticket space: a lead agent starts in a new ticket folder with a handoff
 * from the plain space's agent, that agent's sessions end, and only then is
 * its worktree moved into the folder.
 */
export async function addRepoToSpace(
	env: TicketEnv,
	options: AddRepoOptions,
): Promise<AddRepoResult> {
	const {key} = options;
	return changingTicket(env, key, async () => {
		// Planned once the ticket is this run's to change: what an earlier
		// change left is what this one adds to.
		const plan = planAddRepo(env, options);
		switch (plan.kind) {
			case 'add': {
				return addToTicket(env, plan.known, plan.added);
			}

			case 'reopen': {
				const reopened = await makeTicketSpace(env, {
					key,
					repos: [plan.added.name],
				});
				return {kind: 'added', ...reopened};
			}

			case 'convert': {
				return convertPlainSpace(env, key, plan);
			}
		}
	});
}

async function addToTicket(
	env: TicketEnv,
	known: Ticket,
	added: RepoContext,
): Promise<AddRepoResult> {
	const {key} = known;
	const {member, warning} = await bringIn(env, key, known.folder, added);
	const ticket = withTicketRepo(known, member);
	env.tickets.write(ticket);
	await writeTicketFolder(env, ticket);
	env.showCompanions(ticket);
	const told = await env.tellLead(
		key,
		`The repo ${added.name} was added to this ticket. Its worktree is ${whereFrom(ticket.folder, member)} on the branch ${key}. CLAUDE.md in this folder was rewritten and lists it with its PR rules. Read its own CLAUDE.md before you change it.`,
	);
	return {
		kind: 'added',
		ticket,
		warnings: [...(warning ? [warning] : []), ...notTold(told)],
	};
}

/** A repo's worktree as the lead agent reaches it: `./<repo>`, or in full when it is elsewhere. */
function whereFrom(folder: string, member: TicketRepo): string {
	const relative = path.relative(folder, member.worktreePath);
	return relative.startsWith('..') || path.isAbsolute(relative)
		? member.worktreePath
		: `./${relative || member.name}`;
}

function notTold(told: string): string[] {
	return told === 'sent'
		? []
		: [`The lead agent was not told (${told}): tell it yourself`];
}

async function writeHandoff(
	env: TicketEnv,
	key: string,
	folder: string,
	handing: readonly Handing[],
): Promise<void> {
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
}

async function convertPlainSpace(
	env: TicketEnv,
	key: string,
	plan: Extract<AddRepoPlan, {kind: 'convert'}>,
): Promise<AddRepoResult> {
	const {added, known, folder, handing} = plan;
	const own = env.daos(env.workdir.name);
	const [{repo: origin}] = handing as [Handing];
	fs.mkdirSync(folder, {recursive: true});
	const warnings: string[] = [];

	// The ticket as it will be: what a ticket closed earlier under this key
	// held, the plain worktrees where they are once they have moved, and the
	// new repo.
	let ticket: Ticket = {key, folder, repos: known?.repos ?? []};
	for (const {repo} of handing) {
		ticket = withTicketRepo(ticket, {
			name: repo.name,
			worktreePath: memberWorktree(folder, repo.name),
		});
	}

	// What this run does for the new repo, to undo if the lead agent cannot
	// start: a worktree it made, which nothing has worked in, or one it moved.
	let brought: BroughtIn | undefined;
	if (!handing.some(({repo}) => repo.name === added.name)) {
		brought = await bringIn(env, key, folder, added);
		if (brought.warning) warnings.push(brought.warning);
		ticket = withTicketRepo(ticket, brought.member);
	}

	// The new repo's setup can take minutes, in which the plain agents worked
	// on. They are told only now, and the handoff is what they have done by now.
	const leaving = handing.map(({repo}) => repo.name);
	// A plain agent that cannot be told (it is at a prompt, or gone) is ended
	// all the same: the handoff holds what it did.
	const tellLeaving = async (text: string) =>
		Promise.all(
			leaving.map(async name =>
				env.tellSpace(name, key, text).catch(() => 'failed'),
			),
		);
	await tellLeaving(
		`${key} is becoming a ticket space: ${added.name} was added to it. A lead agent is starting in ${folder} with a handoff of your last turns and your diff, and this session ends as soon as it is up. Stop here and start nothing new.`,
	);
	await writeHandoff(env, key, folder, handing);

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
	try {
		await startLead(env, key, {
			prompt: handoffPrompt(
				key,
				leaving,
				ticket.repos.map(repo => repo.name),
			),
		});
	} catch (error) {
		// Back to the plain space it was, whatever stopped the lead agent. Of
		// the worktrees, only the one this run made is removed, which no agent
		// ever ran in, and one it moved in goes back where it was. The plain
		// spaces were not touched.
		const reason = error instanceof Error ? error.message : String(error);
		let left = '';
		const at = brought?.member.worktreePath;
		try {
			if (brought?.created)
				await env.git(added.mainRoot, ['worktree', 'remove', '--force', at!]);
			else if (brought?.movedFrom)
				await env.git(added.mainRoot, [
					'worktree',
					'move',
					at!,
					brought.movedFrom,
				]);
		} catch {
			left = `. The worktree of ${added.name} is still at ${at}`;
		}

		if (known) env.tickets.write(known);
		else env.tickets.remove(key);
		removeTicketFiles(folder);
		removeIfEmpty(folder);
		const stays = `${key} stays a plain space in ${leaving.join(' and ')}`;
		await tellLeaving(
			`The lead agent could not be started, so ${stays} and this session carries on: ${reason}`,
		);
		if (!(error instanceof TicketError)) throw error;
		throw new TicketError(`${reason}. ${stays}${left}`);
	}

	// The handoff is in the lead agent's hands: now the plain agents can end,
	// and only then do their worktrees move.
	const ended = new Map<string, boolean>();
	for (const {repo} of handing)
		ended.set(repo.name, await env.endSessions(repo.name, key));
	// Nothing changes in those worktrees any more: the handoff's last word,
	// written before the lead agent has had the time to read the first.
	await writeHandoff(env, key, folder, handing);
	const stayed: BroughtIn[] = [];
	for (const {repo, identity} of handing) {
		const brought = ended.get(repo.name)
			? await moveEnded(env, key, folder, repo, identity)
			: stayAt(repo, identity, 'its sessions could not be ended');
		if (brought.warning) {
			warnings.push(brought.warning);
			stayed.push(brought);
		}

		ticket = withTicketRepo(ticket, brought.member);
	}

	env.tickets.write(ticket);
	await writeTicketFolder(env, ticket);
	env.showCompanions(ticket);
	if (stayed.length > 0) {
		// The lead agent was started on `./<repo>`: it has to hear where the
		// worktree really is, or it waits for a directory that never comes.
		const told = await env.tellLead(
			key,
			`${stayed.map(({warning}) => warning).join('. ')}. Work on ${stayed.map(({member}) => member.name).join(' and ')} there, not under this folder: CLAUDE.md here was rewritten and gives the full path.`,
		);
		warnings.push(...notTold(told));
	}

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
