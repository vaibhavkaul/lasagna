// The hook half of closing a space, shared by the TUI's `x`/`K`/auto-remove
// path and `lasagna close`, so both run the same pre_workspace_deinit
// hooks for the same space.

import {
	getMainRepoRoot,
	getRepoName,
	getRepoRoot,
	matchProfileByProject,
	matchProfiles,
	readConfig,
	type CommandConfig,
	type ConfigLoad,
	type PappardelleConfig,
} from './config.ts';
import type {TrackerIssue} from './providers/types.ts';
import {defaultRepoContext} from './repo-context.ts';
import {
	runPreWorkspaceDeinit,
	type DeinitContext,
	type DeinitResult,
} from './workspace-deinit.ts';

export function resolveDeinitCommands(
	config: PappardelleConfig,
	trackerIssue: TrackerIssue | null | undefined,
): CommandConfig[] {
	const commands: CommandConfig[] = [...(config.pre_workspace_deinit ?? [])];

	let matched: {profile: {pre_workspace_deinit?: CommandConfig[]}} | undefined;
	if (trackerIssue?.project?.name) {
		matched =
			matchProfileByProject(
				config,
				trackerIssue.project.name,
				trackerIssue.project.key,
			) ?? undefined;
	}

	if (!matched && trackerIssue?.title) {
		matched = matchProfiles(config, trackerIssue.title)[0];
	}

	commands.push(...(matched?.profile.pre_workspace_deinit ?? []));
	return commands;
}

/**
 * `lasagna close` unregisters a space from outside the TUI, whose row stays
 * up until the next refresh. Attaching to that row would recreate the sessions
 * the close just ended. An unreadable registry (null) attaches anyway, so a
 * read failure can't blank the viewer panes.
 */
export function shouldAttach(
	space: {name: string; isMainWorktree?: boolean; isPending?: boolean},
	registered: readonly string[] | null,
): boolean {
	if (space.isMainWorktree || space.isPending || registered === null) {
		return true;
	}

	return registered.includes(space.name);
}

export type ClosingSpace = {
	name: string;
	worktreePath: string | null;
	trackerIssue: TrackerIssue | null | undefined;
};

export type CloseHooksDeps = {
	readConfig: () => ConfigLoad;
	runDeinit: (
		commands: CommandConfig[],
		worktreePath: string,
		context: DeinitContext,
	) => Promise<DeinitResult>;
	context: () => Omit<DeinitContext, 'issueKey'>;
};

export const defaultCloseHooksDeps: CloseHooksDeps = {
	readConfig: () => readConfig(),
	runDeinit: runPreWorkspaceDeinit,
	context: () => ({
		repoRoot: getRepoRoot(),
		mainRepoRoot: getMainRepoRoot(),
		repoName: getRepoName(),
		// The repo's `.envrc` reaches its hooks, as it does everything else
		// started for the repo.
		env: defaultRepoContext().env,
	}),
};

/**
 * The hooks of a space named on a rail that shows several repos: its own
 * repo's config and roots. Run them for the space's key within that repo.
 */
export function closeHooksDepsFor(repo: {
	root: string;
	mainRoot: string;
	name: string;
	readConfig: () => ConfigLoad;
	env: NodeJS.ProcessEnv;
}): CloseHooksDeps {
	return {
		readConfig: () => repo.readConfig(),
		runDeinit: runPreWorkspaceDeinit,
		context: () => ({
			repoRoot: repo.root,
			mainRepoRoot: repo.mainRoot,
			repoName: repo.name,
			env: repo.env,
		}),
	};
}

export type CloseHooksOutcome =
	| {kind: 'ran'}
	| {kind: 'failed'; failedCommand?: string}
	| {kind: 'config-invalid'; errors: string[]};

export function deinitSkipped(key: string): string {
	return `Skipped the deinit commands of ${key}: the config is invalid`;
}

/**
 * An invalid config can't say which deinit commands a space has, and must not
 * leave the space impossible to close, so the caller closes it and says so.
 */
export async function runCloseHooks(
	space: ClosingSpace,
	deps: CloseHooksDeps = defaultCloseHooksDeps,
): Promise<CloseHooksOutcome> {
	const load = deps.readConfig();
	if (load.kind === 'invalid')
		return {kind: 'config-invalid', errors: load.errors};
	if (load.kind === 'missing' || !space.worktreePath) return {kind: 'ran'};
	const commands = resolveDeinitCommands(load.config, space.trackerIssue);
	if (commands.length === 0) return {kind: 'ran'};
	const result = await deps.runDeinit(commands, space.worktreePath, {
		issueKey: space.name,
		...deps.context(),
	});
	return result.success
		? {kind: 'ran'}
		: {kind: 'failed', failedCommand: result.failedCommand};
}

/**
 * The hooks of a ticket space: each repo's own `pre_workspace_deinit`, run
 * in that repo's worktree with that repo's config, one repo after the other
 * in the ticket's order. The first that fails stops the close, as a plain
 * space's does; a repo whose config is invalid is skipped and reported.
 */
export async function runTicketCloseHooks(
	space: Omit<ClosingSpace, 'worktreePath'>,
	members: ReadonlyArray<{
		repo: Parameters<typeof closeHooksDepsFor>[0];
		worktreePath: string;
	}>,
	depsFor: (
		repo: Parameters<typeof closeHooksDepsFor>[0],
	) => CloseHooksDeps = closeHooksDepsFor,
): Promise<CloseHooksOutcome> {
	const invalid: string[] = [];
	for (const {repo, worktreePath} of members) {
		const outcome = await runCloseHooks(
			{...space, worktreePath},
			depsFor(repo),
		);
		if (outcome.kind === 'failed')
			return {
				kind: 'failed',
				failedCommand: `${repo.name}: ${outcome.failedCommand ?? 'unknown'}`,
			};
		if (outcome.kind === 'config-invalid')
			invalid.push(...outcome.errors.map(error => `${repo.name}: ${error}`));
	}

	return invalid.length > 0
		? {kind: 'config-invalid', errors: invalid}
		: {kind: 'ran'};
}
