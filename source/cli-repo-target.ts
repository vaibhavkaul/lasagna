// Which repo a CLI invocation is about. It is the checkout the command runs
// in, as ever, unless the space it names is in another repo of the same work
// dir (`repo:KEY`, or a bare key only that repo has), or the command runs at
// the work dir's root, which is no checkout: then the process is pointed at
// that repo before anything reads the repo it was started in.

import {
	loadProviderConfigs,
	readBeadsIssuePrefix,
	repoRootsAt,
	setDefaultRepo,
	workdirRepoRoots,
	type RepoRoots,
} from './config.ts';
import {cliSpaceKey} from './cli-space-key.ts';
import {findWorkdir} from './repo-config-files.ts';
import {repoContextOf, type RepoContext} from './repo-context.ts';
import {parseSpaceRef, resolveSpaceRef, spaceRefError} from './space-ref.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {createStateDaos} from './state-daos.ts';
import {SUPERVISE_VERBS} from './supervise-args.ts';
import {readWorkdir, type Workdir} from './workdir.ts';

/** A space key in argv: where it is, and the text before it in that argument. */
type KeyArg = {index: number; value: string; prefix: string};

const plain = (argv: readonly string[], index: number): KeyArg[] => {
	const value = argv[index];
	return value === undefined || value.startsWith('-')
		? []
		: [{index, value, prefix: ''}];
};

/** The first argument from `start` that is neither a flag nor a flag's value. */
function firstPositional(
	argv: readonly string[],
	start: number,
	valueFlags: readonly string[] = [],
): KeyArg[] {
	for (let index = start; index < argv.length; index++) {
		const arg = argv[index]!;
		if (valueFlags.includes(arg)) index++;
		else if (!arg.startsWith('-')) return [{index, value: arg, prefix: ''}];
	}

	return [];
}

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
		case 'schedule':
		case 'schedules': {
			return plain(argv, 1);
		}

		case 'holds': {
			return second === 'approve' || second === 'dismiss' ? [] : plain(argv, 1);
		}

		case 'watch': {
			const keys: KeyArg[] = [];
			for (let index = 1; index < argv.length; index++) {
				if (argv[index]!.startsWith('-')) break;
				keys.push({index, value: argv[index]!, prefix: ''});
			}

			return keys;
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
			// `repo:KEY` names a repo; a prompt is free text.
			if (SUBCOMMANDS.has(verb)) return [];
			const positionals = argv
				.map((value, index) => ({index, value, prefix: ''}))
				.filter(
					({value, index}) =>
						!value.startsWith('-') &&
						!['--profile', '--agent-profile'].includes(argv[index - 1] ?? ''),
				);
			return positionals.length === 1 &&
				parseSpaceRef(positionals[0]!.value).repo !== undefined
				? positionals
				: [];
		}
	}
}

export type RetargetResult =
	/** The command runs for the repo it was started in, as typed. */
	| {kind: 'unchanged'}
	/**
	 * `argv` has each `repo:KEY` cut down to its key. `repo` is the repo to
	 * point the process at, unset when it is the checkout it already runs in.
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
};

function checkoutAt(directory: string): RepoRoots | undefined {
	try {
		return repoRootsAt(directory);
	} catch {
		return undefined;
	}
}

/** Whether a repo's stores know a space the user typed as `typed`. */
export function repoHasSpace(repo: RepoContext, typed: string): boolean {
	try {
		const provider =
			loadProviderConfigs(repo.configPaths()).issue_tracker?.provider ??
			'linear';
		const resolved = cliSpaceKey(typed, repo.readConfig(), provider, () =>
			readBeadsIssuePrefix(repo.mainRoot),
		);
		if (resolved.kind !== 'key') return false;
		if (resolved.key === MAIN_WORKTREE_KEY) return true;
		const daos = createStateDaos({
			repo: repo.name,
			mainRoot: () => repo.mainRoot,
		});
		return (
			daos.registry.has(resolved.key) ||
			daos.spaceState.lookup(resolved.key).kind === 'state'
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
});

/**
 * Decide which repo `argv` is about. Nothing is looked up for a command that
 * names no repo and runs outside a work dir, so a single repo's commands pay
 * nothing for this.
 */
export function retargetCli(
	argv: readonly string[],
	deps: RetargetDeps,
): RetargetResult {
	const keys = spaceKeyArgs(argv);
	const named = keys.some(key => parseSpaceRef(key.value).repo !== undefined);
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

	if (workdirRoot === undefined)
		return named
			? {
					kind: 'error',
					message:
						'repo:KEY names a repo of a work dir, and this directory is in none (no .lasagna/workdir.yml above it)',
				}
			: {kind: 'unchanged'};

	checkout ??= deps.checkoutAt(deps.cwd);
	const workdir = deps.readWorkdir(workdirRoot);
	const workdirRepo = workdirRepoRoots(workdir.root);
	// Outside every checkout the command is about the work dir itself.
	const own = checkout ?? workdirRepo;
	const rootsOf = (name: string): RepoRoots | undefined => {
		if (name === workdirRepo.name) return workdirRepo;
		const listed = workdir.repos.find(repo => repo.name === name);
		return listed && deps.checkoutAt(listed.root);
	};

	const repos = [workdirRepo.name, ...workdir.repos.map(repo => repo.name)];
	const hasSpace = (repo: string, typed: string) => {
		const roots = repo === own.name ? own : rootsOf(repo);
		return roots !== undefined && deps.hasSpace(repoContextOf(roots), typed);
	};

	const resolutions = keys.map(key => {
		const resolution = resolveSpaceRef(key.value, {
			ownRepo: own.name,
			repos,
			hasSpace,
		});
		// A key no repo has falls to the command's own repo, which says so. The
		// work dir is nobody's repo to fall to: the answer names the repos.
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

	if (targets.size > 1)
		return {
			kind: 'error',
			message: `One command acts on one repo's spaces; these are in ${[...targets].join(' and ')}`,
		};
	const [target = own.name] = targets;
	const roots = target === own.name ? own : rootsOf(target);
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
	const result = retargetCli(argv, defaultRetargetDeps());
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
