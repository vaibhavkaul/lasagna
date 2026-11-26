// "Which repo" as a value instead of a property of the process. A process
// that shows the spaces of several repos (a work dir's rail) asks for the
// context of each space's repo; a CLI verb and the single-repo TUI ask for the
// default one, which is the checkout they were started in.

import path from 'node:path';
import {
	getMainRepoRoot,
	getRepoName,
	getRepoRoot,
	readConfig,
	repoConfigPaths,
	repoRootsAt,
	startedIn,
	workdirRepoRoots,
	type ConfigLoad,
	type ConfigPaths,
	type RepoRoots,
} from './config.ts';
import {loadEnvrcIntoProcessEnv} from './envrc.ts';
import {findWorkdir, isWorkdirRepoName} from './repo-config-files.ts';

export type RepoContext = RepoRoots & {
	/** The config layers that apply to this repo. */
	configPaths(): ConfigPaths;
	/** The repo's merged config, read from disk on every call. */
	readConfig(): ConfigLoad;
	/**
	 * The environment of this repo's providers and of everything spawned for
	 * its spaces: the process's own, with the plain `export KEY=VALUE` lines of
	 * the repo's `.envrc`. Nothing is written to `process.env`, so one repo's
	 * keys never reach another's.
	 *
	 * In the checkout the process was started in, the `.envrc` only fills the
	 * variables that aren't set: the shell that started it is the repo's own.
	 * For any other repo (one of a work dir's, or the one a command was
	 * pointed at) the `.envrc` wins, as it does where idow sources it. What
	 * the process inherited there belongs to wherever it was started, and
	 * must not stand in for this repo's keys.
	 */
	readonly env: NodeJS.ProcessEnv;
	/** The work dir whose config applies to the repo, if any. */
	readonly workdir: string | undefined;
};

function build(roots: RepoRoots, paths: () => ConfigPaths): RepoContext {
	let env: NodeJS.ProcessEnv | undefined;
	return {
		...roots,
		configPaths: paths,
		readConfig: () => readConfig(paths()),
		get env() {
			if (!env) {
				env = {...process.env};
				loadEnvrcIntoProcessEnv(roots.root, env, {
					override: !startedIn(roots.root),
				});
			}

			return env;
		},
		get workdir() {
			return isWorkdirRepoName(roots.name)
				? roots.mainRoot
				: findWorkdir(roots.mainRoot);
		},
	};
}

const byRoot = new Map<string, RepoContext>();

/** The context of a repo named by its roots, built once per working tree. */
export function repoContextOf(roots: RepoRoots): RepoContext {
	const key = path.resolve(roots.root);
	let context = byRoot.get(key);
	if (!context) {
		context = build(roots, () => repoConfigPaths(roots));
		byRoot.set(key, context);
	}

	return context;
}

/**
 * The context of the checkout at `root`, built once per directory asked for.
 * Throws NotInGitRepoError when `root` is not inside a checkout.
 */
export function repoContext(root: string): RepoContext {
	const key = path.resolve(root);
	return byRoot.get(key) ?? rememberAs(key, repoContextOf(repoRootsAt(key)));
}

/** The context of a work dir's pseudo-repo, which is not a checkout. */
export function workdirRepoContext(workdir: string): RepoContext {
	return repoContextOf(workdirRepoRoots(workdir));
}

function rememberAs(key: string, context: RepoContext): RepoContext {
	byRoot.set(key, context);
	return context;
}

let ownContext: {root: string; context: RepoContext} | undefined;

/**
 * The repo this process is about: the checkout it was started in, or the one
 * `setDefaultRepo` named. Throws NotInGitRepoError when it has neither.
 */
export function defaultRepoContext(): RepoContext {
	const root = getRepoRoot();
	if (ownContext?.root !== root) {
		const roots = {root, mainRoot: getMainRepoRoot(), name: getRepoName()};
		ownContext = {root, context: repoContextOf(roots)};
	}

	return ownContext.context;
}

/** Forget every context, for tests that move between repos. */
export function resetRepoContexts(): void {
	byRoot.clear();
	ownContext = undefined;
}
