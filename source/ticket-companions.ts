// A ticket space's companion: a shell in the ticket folder, and beside it a
// pane for each repo, started in that repo's worktree with that repo's own
// companion command (a git UI by default). They are companion splits like
// any other, so the TUI frames them and `lasagna companion` reaches them
// by name.

import {
	DEFAULT_COMPANION_COMMAND,
	getCompanionCommand,
	type ResolvedCompanionSplit,
} from './config.ts';
import {PANE_NAME_PATTERN} from './companion-splits.ts';
import type {TicketMember} from './space-scope.ts';

/** The name of a repo's pane: the repo's name, as a pane can be called. */
export function ticketPaneName(repo: string): string {
	const name = repo
		.toLowerCase()
		.replaceAll(/[^a-z\d-]+/g, '-')
		.replace(/^-+/, '');
	return PANE_NAME_PATTERN.test(name) ? name : 'repo';
}

/** One split per repo of the ticket, in the ticket's order. */
export function ticketCompanionSplits(
	members: readonly TicketMember[],
): ResolvedCompanionSplit[] {
	return members.map(member => {
		const load = member.repo.readConfig();
		return {
			name: ticketPaneName(member.repo.name),
			command:
				load.kind === 'valid'
					? getCompanionCommand(load.config)
					: DEFAULT_COMPANION_COMMAND,
			split: 'down',
			cwd: member.worktreePath,
		};
	});
}
