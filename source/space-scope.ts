// The repo behind a space name, for code that is handed a space and must
// act in its repo: read that repo's config, ask its tracker, start programs
// in its checkout with its environment.
//
// A process started in one repo has one answer for every space, and nothing
// here changes what it does. A process that shows a whole work dir installs a
// resolver, and from then on each space name carries its repo.

import {
	readConfig,
	type ConfigLoad,
	type ConfigPaths,
	type RepoRoots,
} from './config.ts';
import {inlineConfigErrors} from './config-errors.ts';
import {readReportedConfig, reportConfigEvent} from './config-report.ts';
import {
	createIssueTracker,
	createVcsHost,
	issueTrackerFor,
	vcsHostFor,
	type IssueTrackerProvider,
	type RailStatus,
	type VcsHostProvider,
} from './providers/index.ts';
import {defaultRepoContext, type RepoContext} from './repo-context.ts';
import {formatSpaceRef} from './space-ref.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';

export type SpaceScope = {
	/** The space's repo. */
	repo: RepoContext;
	/** The space's key within that repo, as idow and the hooks know it. */
	key: string;
};

export type SpaceScopeResolver = (name: string) => SpaceScope | undefined;

let resolver: SpaceScopeResolver | undefined;

/**
 * From now on a space name says which repo it is in. Passing undefined goes
 * back to one repo for every space.
 */
export function setSpaceScopes(resolve: SpaceScopeResolver | undefined): void {
	resolver = resolve;
}

/**
 * The repo and key a space name stands for, or undefined in a process whose
 * spaces are all in the repo it was started in: there the name is the key
 * and the repo is the process's own.
 */
export function scopedSpace(name: string): SpaceScope | undefined {
	return resolver?.(name);
}

/** The space's key within its repo. */
export function spaceBareKey(name: string): string {
	return scopedSpace(name)?.key ?? name;
}

/** Whether the name is a main space: a repo's main checkout, or a work dir's root. */
export function isMainSpaceName(name: string): boolean {
	return spaceBareKey(name) === MAIN_WORKTREE_KEY;
}

/** The space's repo: its own when the name carries one, else the process's. */
export function spaceRepo(name: string): RepoContext {
	return scopedSpace(name)?.repo ?? defaultRepoContext();
}

/** The roots of the space's repo, or undefined for the process's own. */
export function spaceRepoRoots(name: string): RepoRoots | undefined {
	return scopedSpace(name)?.repo;
}

/** The config layers of the space's repo, or undefined for the process's own. */
export function spaceConfigPaths(name: string): ConfigPaths | undefined {
	return scopedSpace(name)?.repo.configPaths();
}

/** The config of the space's repo. */
export function spaceConfig(name: string): ConfigLoad {
	return readConfig(spaceConfigPaths(name));
}

/**
 * `spaceConfig`, with the rail told when it is invalid. The process's own
 * config keeps its one standing line; another repo's is reported by name,
 * since several can be invalid at once.
 */
export function spaceReportedConfig(name: string): ConfigLoad {
	const scope = scopedSpace(name);
	if (!scope) return readReportedConfig();
	const load = scope.repo.readConfig();
	if (load.kind === 'invalid')
		reportConfigEvent(
			`The config of ${scope.repo.name} is invalid: ${inlineConfigErrors(load.errors)}`,
		);
	return load;
}

/** The issue tracker of the space's repo. */
export function spaceTracker(name: string): IssueTrackerProvider {
	const scope = scopedSpace(name);
	return scope ? issueTrackerFor(scope.repo.name) : createIssueTracker();
}

/**
 * The name a repo's space goes by in this process: its key where every space
 * is the process's own repo's, `repo:KEY` where names carry their repo.
 */
export function spaceNameIn(repo: string, key: string): string {
	return resolver ? formatSpaceRef(repo, key) : key;
}

/**
 * PR status for several spaces at once, each repo's from its own VCS host in
 * one bulk request. `worktreePaths` and the answer are keyed by space name.
 */
export async function spacesRailStatus(
	names: readonly string[],
	worktreePaths: ReadonlyMap<string, string>,
): Promise<Map<string, RailStatus>> {
	const byRepo = new Map<string, Array<{name: string; key: string}>>();
	for (const name of names) {
		const scope = scopedSpace(name);
		if (!scope) continue;
		const mine = byRepo.get(scope.repo.name) ?? [];
		mine.push({name, key: scope.key});
		byRepo.set(scope.repo.name, mine);
	}

	if (byRepo.size === 0)
		return createVcsHost().getBulkRailStatus([...names], worktreePaths);

	const result = new Map<string, RailStatus>();
	await Promise.all(
		[...byRepo].map(async ([repo, spaces]) => {
			const paths = new Map(
				spaces.flatMap(({name, key}) => {
					const worktree = worktreePaths.get(name);
					return worktree === undefined ? [] : [[key, worktree] as const];
				}),
			);
			const statuses = await vcsHostFor(repo).getBulkRailStatus(
				spaces.map(({key}) => key),
				paths,
			);
			for (const {name, key} of spaces) {
				const status = statuses.get(key);
				if (status) result.set(name, status);
			}
		}),
	);
	return result;
}

/** The VCS host of the space's repo. */
export function spaceVcsHost(name: string): VcsHostProvider {
	const scope = scopedSpace(name);
	return scope ? vcsHostFor(scope.repo.name) : createVcsHost();
}
