// Which repo a CLI invocation is about. It is the checkout the command runs
// in, as ever, unless the space it names is in another repo of the same work
// dir (`repo:KEY`, or a bare key only that repo has), or the command runs at
// the work dir's root, which is no checkout: then the process is pointed at
// that repo before anything reads the repo it was started in.

import {
	DEFAULT_TEAM_PREFIX,
	getBeadsPrefixes,
	getTeamPrefix,
	loadProviderConfigs,
	readBeadsIssuePrefix,
	repoRootsAt,
	setDefaultRepo,
	workdirRepoRoots,
	type RepoRoots,
} from './config.ts';
import {cliSpaceKey} from './cli-space-key.ts';
import {
	isIssueKey,
	isIssueNumber,
	normalizeIssueIdentifier,
} from './issue-utils.ts';
import {findWorkdir, isAtOrBelow, workdirStoodIn} from './repo-config-files.ts';
import {repoContextOf, type RepoContext} from './repo-context.ts';
import {sameFile} from './same-file.ts';
import {
	formatSpaceRef,
	parseSpaceRef,
	resolveSpaceRef,
	spaceRefError,
} from './space-ref.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {createStateDaos} from './state-daos.ts';
import {SUPERVISE_VERBS} from './supervise-args.ts';
import {readWorkdir, type Workdir} from './workdir.ts';

/** A space key in argv: where it is, and the text before it in that argument. */
type KeyArg = {
	index: number;
	value: string;
	prefix: string;
	/**
	 * A lone word where a prompt goes. It names a space only when it reads as
	 * `repo:KEY` for a repo of the work dir; anything else is the prompt it
	 * always was (`fix:typo`).
	 */
	prompt?: boolean;
};

/**
 * The arguments from `start` that are neither a flag nor a flag's value, and
 * every argument after a `--`.
 */
function positionals(
	argv: readonly string[],
	start: number,
	valueFlags: readonly string[] = [],
): KeyArg[] {
	const found: KeyArg[] = [];
	let onlyPositionals = false;
	for (let index = start; index < argv.length; index++) {
		const arg = argv[index]!;
		if (onlyPositionals || !arg.startsWith('-'))
			found.push({index, value: arg, prefix: ''});
		else if (arg === '--') onlyPositionals = true;
		else if (valueFlags.includes(arg)) index++;
	}

	return found;
}

/** The first argument from `start` that is neither a flag nor a flag's value. */
const firstPositional = (
	argv: readonly string[],
	start: number,
	valueFlags: readonly string[] = [],
): KeyArg[] => positionals(argv, start, valueFlags).slice(0, 1);

const plain = (argv: readonly string[], index: number): KeyArg[] => {
	const value = argv[index];
	return value === undefined || value.startsWith('-')
		? []
		: [{index, value, prefix: ''}];
};

const SUBCOMMANDS = new Set<string>([
	...SUPERVISE_VERBS,
	'space',
	'spaces',
	'send',
	'close',
	'read',
	'highlight',
	'companion',
	'link-pr',
	'agent-profile',
	'mcp',
	'plugin',
	'update',
	'restart',
]);

/**
 * The space keys an invocation names. Each verb takes its key where its own
 * parser does; anything this misses is left for the verb, which then answers
 * for the repo it runs in.
 */
export function spaceKeyArgs(argv: readonly string[]): KeyArg[] {
	const [verb, second] = argv;
	switch (verb) {
		case 'space': {
			return second === 'get' ? firstPositional(argv, 2, ['--field']) : [];
		}

		case 'send':
		case 'screen':
		case 'state':
		case 'wait':
		case 'answer':
		case 'queue':
		case 'schedules': {
			return plain(argv, 1);
		}

		case 'schedule': {
			// `schedule fire ID` is what a timer runs: an id, not a space.
			return second === 'fire' ? [] : plain(argv, 1);
		}

		case 'holds': {
			return second === 'approve' || second === 'dismiss' ? [] : plain(argv, 1);
		}

		case 'watch': {
			// Its keys come before, between or after its flags; the MCP tool
			// puts them last, behind `--`.
			return positionals(argv, 1, ['--until', '--since', '--timeout']);
		}

		case 'close':
		case 'highlight': {
			return firstPositional(argv, 1);
		}

		case 'read': {
			return firstPositional(argv, 1, ['--turns']);
		}

		case 'companion': {
			const keys: KeyArg[] = [];
			for (let index = 1; index < argv.length; index++) {
				const arg = argv[index]!;
				if (arg === '--space' && argv[index + 1] !== undefined)
					keys.push({index: index + 1, value: argv[index + 1]!, prefix: ''});
				else if (arg.startsWith('--space='))
					keys.push({
						index,
						value: arg.slice('--space='.length),
						prefix: '--space=',
					});
			}

			return keys;
		}

		case undefined: {
			return [];
		}

		default: {
			// Opening a space: `lasagna [flags] <issue-key>`. Only a lone
			// `repo:KEY` can name a repo; a prompt is free text.
			if (SUBCOMMANDS.has(verb)) return [];
			const words = argv
				.map((value, index) => ({index, value, prefix: '', prompt: true}))
				.filter(
					({value, index}) =>
						!value.startsWith('-') &&
						!['--profile', '--agent-profile'].includes(argv[index - 1] ?? ''),
				);
			return words.length === 1 &&
				parseSpaceRef(words[0]!.value).repo !== undefined
				? words
				: [];
		}
	}
}

/** A stored thing a verb names by id alone, which says nothing of its repo. */
export type IdArg = {kind: 'schedule' | 'hold'; id: string};

/** The scheduled job or hold an invocation names by its id. */
export function idArg(argv: readonly string[]): IdArg | undefined {
	const [verb, second] = argv;
	const first = (start: number) => firstPositional(argv, start)[0]?.value;
	let found: {kind: IdArg['kind']; id: string | undefined} | undefined;
	if (verb === 'unschedule') found = {kind: 'schedule', id: first(1)};
	else if (verb === 'schedule' && second === 'fire')
		found = {kind: 'schedule', id: first(2)};
	else if (verb === 'holds' && (second === 'approve' || second === 'dismiss'))
		found = {kind: 'hold', id: first(2)};
	return found?.id === undefined ? undefined : {kind: found.kind, id: found.id};
}

export type RetargetResult =
	/** The command runs for the repo it was started in, as typed. */
	| {kind: 'unchanged'}
	/**
	 * `argv` has each `repo:KEY` cut down to its key. `repo` is the repo to
	 * point the process at, unset when it is the checkout it already runs in.
	 * A `watch` of spaces in several repos is pointed at the work dir itself,
	 * with every space spelled `repo:KEY`.
	 */
	| {kind: 'retargeted'; repo?: RepoRoots; argv: string[]}
	| {kind: 'error'; message: string};

export type RetargetDeps = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** The checkout holding a directory, or undefined outside one. */
	checkoutAt: (directory: string) => RepoRoots | undefined;
	readWorkdir: (root: string) => Workdir;
	/** Whether a repo has a space the user typed this way. */
	hasSpace: (repo: RepoContext, typed: string) => boolean;
	/** Whether a repo would open `typed` as an issue key, not as a prompt. */
	readsAsKey: (repo: RepoContext, typed: string) => boolean;
	/** Whether a repo's stores hold the scheduled job or hold with this id. */
	hasId: (repo: RepoContext, id: IdArg) => boolean;
};

function checkoutAt(directory: string): RepoRoots | undefined {
	try {
		return repoRootsAt(directory);
	} catch {
		return undefined;
	}
}

const trackerOf = (repo: RepoContext) =>
	loadProviderConfigs(repo.configPaths()).issue_tracker?.provider ?? 'linear';

const storesOf = (repo: RepoContext) =>
	createStateDaos({repo: repo.name, mainRoot: () => repo.mainRoot});

/**
 * Whether a repo has the space the user typed as `typed` open, or being set
 * up. What a closed space left behind (its title, its PR links) is not a
 * space: counted, an old key would point a command at a repo that no longer
 * has it, or make a key one repo has open look like two repos'.
 */
export function repoHasSpace(repo: RepoContext, typed: string): boolean {
	try {
		const resolved = cliSpaceKey(
			typed,
			repo.readConfig(),
			trackerOf(repo),
			() => readBeadsIssuePrefix(repo.mainRoot),
		);
		if (resolved.kind !== 'key') return false;
		if (resolved.key === MAIN_WORKTREE_KEY) return true;
		const lookup = storesOf(repo).registry.phase(resolved.key);
		return lookup.kind === 'phase' && lookup.phase !== 'closing';
	} catch {
		return false;
	}
}

/** Whether a repo's tracker would read `typed` as one of its issue keys. */
export function repoReadsAsKey(repo: RepoContext, typed: string): boolean {
	try {
		const load = repo.readConfig();
		const config = load.kind === 'valid' ? load.config : undefined;
		return (
			normalizeIssueIdentifier(
				typed,
				config ? getTeamPrefix(config) : DEFAULT_TEAM_PREFIX,
				trackerOf(repo),
				config
					? getBeadsPrefixes(config, readBeadsIssuePrefix(repo.mainRoot))
					: [],
			) !== null
		);
	} catch {
		return isIssueKey(typed) || isIssueNumber(typed);
	}
}

/** Whether a repo's stores hold a scheduled job or a hold by this id. */
export function repoHasId(repo: RepoContext, {kind, id}: IdArg): boolean {
	try {
		const daos = storesOf(repo);
		return (
			(kind === 'schedule' ? daos.schedules.load(id) : daos.holds.load(id)) !==
			null
		);
	} catch {
		return false;
	}
}

export const defaultRetargetDeps = (): RetargetDeps => ({
	cwd: process.cwd(),
	env: process.env,
	checkoutAt,
	readWorkdir,
	hasSpace: repoHasSpace,
	readsAsKey: repoReadsAsKey,
	hasId: repoHasId,
});

/**
 * Decide which repo `argv` is about. Nothing is looked up for a command that
 * names no repo and runs outside a work dir, so a single repo's commands pay
 * nothing for this, and outside a work dir nothing is ever refused: there
 * `a:b` is whatever the verb always took it for.
 */
export function retargetCli(
	argv: readonly string[],
	deps: RetargetDeps,
): RetargetResult {
	const typed = spaceKeyArgs(argv);
	const named = typed.some(key => parseSpaceRef(key.value).repo !== undefined);
	// A space's worktree is outside the work dir, so its session's main
	// checkout is tried too.
	const injectedMain = deps.env['LASAGNA_MAIN_REPO_ROOT'];
	let checkout: RepoRoots | undefined;
	let workdirRoot =
		findWorkdir(deps.cwd, deps.env) ??
		(injectedMain ? findWorkdir(injectedMain, deps.env) : undefined);
	if (workdirRoot === undefined && named) {
		checkout = deps.checkoutAt(deps.cwd);
		workdirRoot = checkout && findWorkdir(checkout.mainRoot, deps.env);
	}

	if (workdirRoot === undefined) return {kind: 'unchanged'};

	checkout ??= deps.checkoutAt(deps.cwd);
	// A checkout that holds the work dir itself is not one of its repos: at
	// the work dir's root the command is about the work dir, as the TUI is.
	if (checkout && workdirStoodIn(deps.cwd, checkout.root, deps.env))
		checkout = undefined;
	const workdir = deps.readWorkdir(workdirRoot);
	const workdirRepo = workdirRepoRoots(workdir.root);
	// Outside every checkout the command is about the work dir itself. So is
	// one run in a ticket space's session, whose agent may be standing in one
	// of the ticket's repos: the space it runs in is the work dir's own.
	const inTicketSpace =
		deps.env['LASAGNA_REPO'] === workdirRepo.name &&
		Boolean(deps.env['LASAGNA_SPACE']?.trim());
	const own = inTicketSpace ? workdirRepo : (checkout ?? workdirRepo);
	const rootsOf = (name: string): RepoRoots | undefined => {
		if (name === own.name) return own;
		if (name === workdirRepo.name) return workdirRepo;
		const listed = workdir.repos.find(repo => repo.name === name);
		return listed && deps.checkoutAt(listed.root);
	};

	const contextOf = (name: string) => {
		const roots = rootsOf(name);
		return roots && repoContextOf(roots);
	};

	const repos = [workdirRepo.name, ...workdir.repos.map(repo => repo.name)];
	// LASAGNA_WORKDIR names a work dir wherever the command runs. A
	// checkout that is none of its repos keeps its bare keys and ids to itself:
	// only a repo typed out reaches into the work dir from there.
	const belongs =
		checkout === undefined ||
		isAtOrBelow(workdir.root, checkout.root) ||
		isAtOrBelow(workdir.root, checkout.mainRoot) ||
		workdir.repos.some(
			repo =>
				repo.name === checkout.name && sameFile(repo.root, checkout.mainRoot),
		);
	const hasSpace = (repo: string, key: string) => {
		const context = contextOf(repo);
		return context !== undefined && deps.hasSpace(context, key);
	};

	const names = (key: KeyArg): boolean => {
		const ref = parseSpaceRef(key.value);
		const known = ref.repo !== undefined && repos.includes(ref.repo);
		if (key.prompt) {
			// A one-word prompt with a colon in it stays a prompt.
			const context = known ? contextOf(ref.repo!) : undefined;
			return context !== undefined && deps.readsAsKey(context, ref.key);
		}

		return belongs || known;
	};

	const resolutions = typed
		.filter(key => names(key))
		.map(key => {
			const resolution = resolveSpaceRef(key.value, {
				ownRepo: own.name,
				repos,
				hasSpace,
			});
			// A key no repo has falls to the command's own repo, which says so.
			// The work dir is nobody's repo to fall to: the answer names the
			// repos.
			return {
				key,
				resolution:
					!checkout &&
					resolution.kind === 'own' &&
					parseSpaceRef(key.value).repo === undefined &&
					!hasSpace(own.name, key.value)
						? ({kind: 'not-found', key: key.value, repos} as const)
						: resolution,
			};
		});

	const rewritten = [...argv];
	const targets = new Set<string>();
	for (const {key, resolution} of resolutions) {
		if (resolution.kind !== 'own' && resolution.kind !== 'other')
			return {kind: 'error', message: spaceRefError(resolution)};
		targets.add(resolution.kind === 'own' ? own.name : resolution.repo);
		rewritten[key.index] = `${key.prefix}${resolution.key}`;
	}

	// An id says nothing of its repo. The command's own repo answers when it
	// has it; else the one repo of the work dir that does. With none, the
	// command's own repo says so, as it always did.
	const id = belongs && typed.length === 0 ? idArg(argv) : undefined;
	if (id) {
		const hasId = (repo: string) => {
			const context = contextOf(repo);
			return context !== undefined && deps.hasId(context, id);
		};

		if (!hasId(own.name)) {
			const holders = repos.filter(repo => repo !== own.name && hasId(repo));
			if (holders.length === 1) targets.add(holders[0]!);
		}
	}

	if (targets.size > 1) {
		// watch is the verb that takes several spaces. Across repos it runs
		// for the work dir, which knows every repo's, each by its full name.
		if (argv[0] === 'watch') {
			const full = [...argv];
			for (const {key, resolution} of resolutions) {
				if (resolution.kind !== 'own' && resolution.kind !== 'other') continue;
				const repo = resolution.kind === 'own' ? own.name : resolution.repo;
				full[key.index] =
					`${key.prefix}${formatSpaceRef(repo, resolution.key)}`;
			}

			return {kind: 'retargeted', repo: workdirRepo, argv: full};
		}

		return {
			kind: 'error',
			message: `One command acts on one repo's spaces; these are in ${[...targets].join(' and ')}`,
		};
	}

	const [target = own.name] = targets;
	const roots = rootsOf(target);
	if (!roots)
		return {
			kind: 'error',
			message: `${target} is listed in the work dir but is not a git checkout`,
		};
	// A checkout the command already runs in needs no pointing at.
	if (roots !== checkout)
		return {kind: 'retargeted', repo: roots, argv: rewritten};
	return rewritten.every((arg, index) => arg === argv[index])
		? {kind: 'unchanged'}
		: {kind: 'retargeted', argv: rewritten};
}

/**
 * Point this process at the repo `argv` is about, and return the arguments
 * with each `repo:KEY` cut down to its key. Exits when a space can't be
 * placed in a repo.
 */
export function retargetProcess(argv: readonly string[]): string[] {
	let deps: RetargetDeps;
	try {
		deps = defaultRetargetDeps();
	} catch {
		// The working directory is gone (a removed worktree). The verb says so
		// in its own words, as it did before there was anything to point at.
		return [...argv];
	}

	const result = retargetCli(argv, deps);
	switch (result.kind) {
		case 'unchanged': {
			return [...argv];
		}

		case 'error': {
			console.error(result.message);
			// eslint-disable-next-line unicorn/no-process-exit
			process.exit(2);
		}

		// eslint-disable-next-line no-fallthrough
		case 'retargeted': {
			const {repo} = result;
			if (!repo) return result.argv;
			setDefaultRepo(repo);
			// Everything that runs git, gh or a tracker CLI without naming a
			// directory now runs in the repo the space is in, and what this
			// process starts is told that repo's main checkout, not the caller's.
			try {
				process.chdir(repo.mainRoot);
			} catch {
				// The verb reports a main checkout that is gone.
			}

			if (process.env['LASAGNA_MAIN_REPO_ROOT'] !== undefined)
				process.env['LASAGNA_MAIN_REPO_ROOT'] = repo.mainRoot;
			if (process.env['LASAGNA_REPO'] !== undefined)
				process.env['LASAGNA_REPO'] = repo.name;
			return result.argv;
		}
	}
}
