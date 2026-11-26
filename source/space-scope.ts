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
	type VcsHostProvider,
} from './providers/index.ts';
import {defaultRepoContext, type RepoContext} from './repo-context.ts';
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

/** The VCS host of the space's repo. */
export function spaceVcsHost(name: string): VcsHostProvider {
	const scope = scopedSpace(name);
	return scope ? vcsHostFor(scope.repo.name) : createVcsHost();
}
