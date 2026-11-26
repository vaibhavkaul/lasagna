// Auto-remove spaces from the ticket rail when their tracker issue
// reaches a terminal state (completed or canceled). Triggered by the
// top-level `auto_remove_when_done` config flag.
import {
	getAutoRemoveWhenDone,
	type ConfigLoad,
	type PappardelleConfig,
} from './config.ts';
import type {SpaceData} from './types.ts';

/**
 * The `state.type` values that count as "done" for auto-removal.
 *
 * The vocabulary is Linear's workflow state types ('completed' | 'canceled').
 * Every other provider translates into it: `mapJiraIssue` turns Jira's Done
 * status category into 'completed' (STA-2139). A provider that slugs its own
 * words instead makes both `auto_remove_when_done` and `K` dead on that rig,
 * so the translation belongs in the provider, not in a widened set here.
 */
export const AUTO_REMOVE_STATE_TYPES = new Set(['completed', 'canceled']);

/**
 * Return the spaces whose tracker issue is completed or canceled, in rail
 * order. Pure — the caller runs the teardown.
 *
 * The main worktree is excluded because it can never be closed, and pending
 * rows are excluded because they are placeholders for a workspace that does
 * not exist on disk yet. A space with no issue attached is left alone: an
 * absent issue is unknown state, not terminal state.
 *
 * Shared with the `K` shortcut (STA-2111), which closes the same set on
 * demand. Keeping one predicate means the flag and the key can never disagree
 * about what "done" means.
 */
export function findDoneSpaces(spaces: SpaceData[]): SpaceData[] {
	return spaces.filter(space => {
		if (space.isMainWorktree) return false;
		if (space.isPending) return false;
		const issue = space.trackerIssue ?? space.linearIssue;
		if (!issue) return false;
		return AUTO_REMOVE_STATE_TYPES.has(issue.state.type);
	});
}

/**
 * Return the subset of `spaces` whose tracker issue has entered a terminal
 * state and should be auto-removed from the rail. Pure function — the caller
 * is responsible for actually invoking the removal flow.
 *
 * Off-by-default: when `autoRemoveWhenDone` is undefined or false, returns []
 * regardless of issue state. Pinned by the regression test in
 * `auto-remove.test.ts` so adding the field can never silently change legacy
 * behavior.
 */
export function findSpacesToAutoRemove(
	spaces: SpaceData[],
	autoRemoveWhenDone: boolean | undefined,
): SpaceData[] {
	if (!autoRemoveWhenDone) return [];
	return findDoneSpaces(spaces);
}

/**
 * `findSpacesToAutoRemove` on a rail of several repos, where each space
 * answers for its own repo: one repo's `auto_remove_when_done` says nothing
 * of another's spaces, and neither does the work dir's.
 *
 * `configOf` is the config of the space's repo as the rail read it at
 * startup (null when it had none that loads), which is where the flag is
 * read, as a single repo's rail reads its own. `currentConfig` is that repo's
 * config as it is on disk now: nobody asked for these closes, so a space
 * waits while its repo's config can't say which deinit commands to run. It is
 * read once per repo however many of the repo's spaces are done.
 */
export function findRepoSpacesToAutoRemove(
	spaces: SpaceData[],
	repo: {
		configOf: (space: SpaceData) => PappardelleConfig | null;
		currentConfig: (space: SpaceData) => ConfigLoad;
	},
): SpaceData[] {
	const invalid = new Map<string | undefined, boolean>();
	return findDoneSpaces(spaces).filter(space => {
		const config = repo.configOf(space);
		if (!config || !getAutoRemoveWhenDone(config)) return false;
		let known = invalid.get(space.repo);
		if (known === undefined) {
			known = repo.currentConfig(space).kind === 'invalid';
			invalid.set(space.repo, known);
		}

		return !known;
	});
}
