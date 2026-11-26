// What a TUI clears off the user's own tmux server as it starts.

import {cleanupOrphanedOuterSessions, type OuterTmuxRunner} from './tmux.ts';

/**
 * Kill what a run from before the inner socket left on the default tmux
 * socket, for the repo the TUI was started for, and return how many it
 * killed.
 *
 * That socket is the user's, and the sweep goes by name alone: every session
 * called `agent-`, `claude-`, `companion-` or `lazygit-<repo>-…`. So it
 * covers `own` only, as a single repo's TUI always has. A work dir's TUI does
 * not sweep it for the repos it lists: that would end any session of the
 * user's that happens to be named after one of them, for leftovers only that
 * repo's own TUI could have made, and which that TUI still clears when it
 * starts. Sessions on the inner socket, which is Lasagna's alone, are
 * looked after per repo by the caller.
 */
export function clearStaleOuterSessions(
	tui: {own: string; listed: readonly string[]},
	runner?: OuterTmuxRunner,
): number {
	return cleanupOrphanedOuterSessions(tui.own, runner);
}
