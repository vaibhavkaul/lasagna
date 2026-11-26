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
const MAINS_COLOR = 'gray';

/** The header the repos' main spaces sit under. */
export const MAIN_SPACES_GROUP: RailGroup = {
	id: 'workdir-main-spaces',
	name: 'repos',
	color: MAINS_COLOR,
	statuses: [],
	categories: [],
};

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
 * header over its spaces, in the order the work dir lists its repos. Grouped
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
		for (const space of [...workspaces].sort(byRepoOrder))
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
