// The rail of a work dir: the root main space, each repo's main space under
// a header that folds, then every repo's spaces grouped by repo or by ticket.
// The rows are the same kinds the single-repo rail draws (rail-groups.ts).

import {isWorkdirRepoName} from './repo-config-files.ts';
import {
	isAgentSpace,
	railGroupId,
	type RailGroup,
	type RailRow,
} from './rail-groups.ts';
import {compareSpaceNames, MAIN_WORKTREE_KEY} from './space-utils.ts';
import type {SpaceData} from './types.ts';

/** What the spaces under the main spaces are grouped by. */
export type WorkdirGrouping = 'repo' | 'ticket';

export const WORKDIR_GROUPINGS: readonly WorkdirGrouping[] = ['repo', 'ticket'];

export function nextWorkdirGrouping(current: WorkdirGrouping): WorkdirGrouping {
	return current === 'repo' ? 'ticket' : 'repo';
}

const GROUP_COLOR = '#4b9fea';
const TICKETS_COLOR = '#c678dd';
const MAINS_COLOR = 'gray';

/** The header the repos' main spaces sit under. */
export const MAIN_SPACES_GROUP: RailGroup = {
	id: 'workdir-main-spaces',
	name: 'repos',
	color: MAINS_COLOR,
	statuses: [],
	categories: [],
};

/** The header ticket spaces sit under when the rail is grouped by repo. */
export const TICKET_SPACES_GROUP: RailGroup = {
	id: 'workdir-ticket-spaces',
	name: 'tickets',
	color: TICKETS_COLOR,
	statuses: [],
	categories: [],
};

/** A ticket space: the work dir's own, holding a worktree of several repos. */
export function isTicketSpace(space: SpaceData): boolean {
	return (
		!isAgentSpace(space) &&
		space.repo !== undefined &&
		isWorkdirRepoName(space.repo)
	);
}

/** The work dir's repos a space is not in yet. */
export function addableRepos(
	space: SpaceData,
	repos: readonly string[],
): string[] {
	const held = new Set(
		space.ticketRepos?.map(repo => repo.name) ?? [space.repo],
	);
	return repos.filter(name => !held.has(name));
}

/**
 * Why the rail's `a` cannot add a repo to the selected space right now, or
 * undefined when it can. `adding` holds the keys of the spaces a repo is
 * being added to: a second add to one of them would only wait behind the
 * first, with nothing on screen to say so, and a second conversion of the
 * same plain space would find it half-way to a ticket space.
 */
export function addRepoRefusal(
	space: SpaceData | undefined,
	options: {
		repos: readonly string[];
		adding: Pick<ReadonlySet<string>, 'has'>;
	},
): string | undefined {
	if (!space || space.isMainWorktree || space.isPending || !space.key)
		return 'Select a space to add a repo to';
	if (options.adding.has(space.key))
		return `A repo is still being added to ${space.key}. Add the next one when it is done`;
	if (addableRepos(space, options.repos).length === 0)
		return `Every repo of the work dir is already in ${space.key}`;
	return undefined;
}

function group(kind: WorkdirGrouping, name: string): RailGroup {
	return {
		id: `${kind}-${railGroupId(name)}`,
		name,
		color: GROUP_COLOR,
		statuses: [],
		categories: [],
	};
}

/** The work dir's own main space, which leads the rail. */
export function isRootMainSpace(space: SpaceData): boolean {
	return (
		isAgentSpace(space) &&
		space.repo !== undefined &&
		isWorkdirRepoName(space.repo)
	);
}

/** A repo's main space: its main checkout, kept reachable under the repos header. */
export function isRepoMainSpace(space: SpaceData): boolean {
	return isAgentSpace(space) && !isRootMainSpace(space);
}

const ticketOf = (space: SpaceData) => space.key ?? space.name;

function rowOf(space: SpaceData): RailRow {
	return space.isPending ? {kind: 'pending', space} : {kind: 'space', space};
}

/** Spaces being started lead their group, as they do on the single-repo rail. */
function pendingFirst(spaces: readonly SpaceData[]): SpaceData[] {
	return [
		...spaces.filter(space => space.isPending),
		...spaces.filter(space => !space.isPending),
	];
}

/**
 * The rows of a work dir's rail. Grouped by repo, each repo with a space is a
 * header over its spaces, in the order the work dir lists its repos, after
 * the ticket spaces, which are in several repos, under a header of their own. Grouped
 * by ticket, each key is a header over the spaces every repo has for it, so a
 * ticket that spans repos reads as one. Spaces keep their incoming order
 * within a group. The narrow layout has too few rows to spare for headers and
 * keeps the order without them.
 */
export function buildWorkdirRailRows(options: {
	displaySpaces: readonly SpaceData[];
	grouping: WorkdirGrouping;
	/** The work dir's repos in its order; a repo not among them goes last. */
	repos: readonly string[];
	/** Whether the repos' main spaces are hidden under their header. */
	mainsFolded: boolean;
	headers?: boolean;
}): RailRow[] {
	const {displaySpaces, grouping, repos, mainsFolded, headers = true} = options;
	const repoOrder = (space: SpaceData) => {
		const index = space.repo === undefined ? -1 : repos.indexOf(space.repo);
		return index === -1 ? repos.length : index;
	};

	const byRepoOrder = (a: SpaceData, b: SpaceData) =>
		repoOrder(a) - repoOrder(b);
	const rootMains = displaySpaces.filter(space => isRootMainSpace(space));
	const repoMains = displaySpaces
		.filter(space => isRepoMainSpace(space))
		.sort(byRepoOrder);
	const workspaces = displaySpaces.filter(space => !isAgentSpace(space));

	const rows: RailRow[] = rootMains.map(space => ({kind: 'space', space}));
	if (repoMains.length > 0) {
		if (headers)
			rows.push({
				kind: 'header',
				group: MAIN_SPACES_GROUP,
				count: repoMains.length,
				folded: mainsFolded,
			});
		if (!mainsFolded || !headers)
			rows.push(...repoMains.map(space => ({kind: 'space' as const, space})));
	}

	const groups = new Map<string, {group: RailGroup; spaces: SpaceData[]}>();
	const add = (name: string, space: SpaceData) => {
		const entry = groups.get(name) ?? {
			group: group(grouping, name),
			spaces: [],
		};
		entry.spaces.push(space);
		groups.set(name, entry);
	};

	// A space started from a description has no key until idow files its
	// issue, so on the ticket rail it waits above the tickets.
	const unkeyed: SpaceData[] = [];
	if (grouping === 'repo') {
		const tickets = workspaces.filter(space => isTicketSpace(space));
		if (tickets.length > 0)
			// Keyed as no repo can be named.
			groups.set('@tickets', {
				group: TICKET_SPACES_GROUP,
				spaces: tickets,
			});
		for (const space of workspaces
			.filter(each => !isTicketSpace(each))
			.sort(byRepoOrder))
			add(space.repo ?? '', space);
	} else {
		const keyed = workspaces.filter(space => ticketOf(space) !== '');
		unkeyed.push(...workspaces.filter(space => ticketOf(space) === ''));
		const tickets = [...new Set(keyed.map(space => ticketOf(space)))].sort(
			compareSpaceNames,
		);
		for (const ticket of tickets) {
			for (const space of keyed
				.filter(each => ticketOf(each) === ticket)
				.sort(byRepoOrder))
				add(ticket, space);
		}
	}

	rows.push(...unkeyed.map(space => rowOf(space)));
	for (const {group: header, spaces} of groups.values()) {
		if (headers)
			rows.push({kind: 'header', group: header, count: spaces.length});
		rows.push(...pendingFirst(spaces).map(space => rowOf(space)));
	}

	return rows;
}

/**
 * What a work dir's row is called in place of its `repo:KEY` name: the key,
 * a repo's name for its main space, and for the work dir's own main space
 * the sous-chef's name when it has one.
 */
export function workdirRowLabel(
	space: SpaceData,
	rootMainLabel: string | undefined,
): string | undefined {
	if (isRootMainSpace(space)) return rootMainLabel ?? MAIN_WORKTREE_KEY;
	if (isRepoMainSpace(space)) return space.repo;
	return space.key;
}
