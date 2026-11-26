import {test, expect} from 'bun:test';
import {
	AUTO_REMOVE_STATE_TYPES,
	findDoneSpaces,
	findRepoSpacesToAutoRemove,
	findSpacesToAutoRemove,
} from './auto-remove.ts';
import type {PappardelleConfig} from './config.ts';
import {mapJiraIssue} from './providers/jira-provider.ts';
import type {TrackerIssue} from './providers/types.ts';
import type {SpaceData} from './types.ts';

// ============================================================================
// Helpers
// ============================================================================

function makeIssue(stateType: string, stateName = stateType): TrackerIssue {
	return {
		identifier: 'STA-1',
		title: 'Test issue',
		state: {name: stateName, type: stateType, color: '#95a2b3'},
		project: null,
	};
}

function makeSpace(
	name: string,
	overrides: Partial<SpaceData> = {},
): SpaceData {
	return {
		name,
		worktreePath: `/tmp/${name}`,
		...overrides,
	};
}

// ============================================================================
// Regression: off-by-default
// ============================================================================

test('regression: off by default — returns no spaces when flag is false', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
		makeSpace('STA-30', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	expect(findSpacesToAutoRemove(spaces, false)).toStrictEqual([]);
});

test('regression: off by default — returns no spaces when flag is undefined', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
	];
	expect(findSpacesToAutoRemove(spaces, undefined)).toStrictEqual([]);
});

// ============================================================================
// Enabled behavior
// ============================================================================

test('returns spaces whose tracker state.type is "completed" when enabled', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	const result = findSpacesToAutoRemove(spaces, true);
	expect(result.length).toBe(1);
	expect(result[0]!.name).toBe('STA-10');
});

test('returns spaces whose tracker state.type is "canceled" when enabled', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	const result = findSpacesToAutoRemove(spaces, true);
	expect(result.length).toBe(1);
	expect(result[0]!.name).toBe('STA-10');
});

test('returns both completed and canceled in a single pass', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {trackerIssue: makeIssue('completed', 'Done')}),
		makeSpace('STA-20', {trackerIssue: makeIssue('canceled', 'Cancelled')}),
		makeSpace('STA-30', {trackerIssue: makeIssue('started', 'In Progress')}),
		makeSpace('STA-40', {trackerIssue: makeIssue('backlog', 'Backlog')}),
	];
	const names = findSpacesToAutoRemove(spaces, true).map(s => s.name);
	expect(names.sort()).toStrictEqual(['STA-10', 'STA-20']);
});

test('ignores non-terminal state types (started, backlog, unstarted, triage)', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-1', {trackerIssue: makeIssue('triage', 'Triage')}),
		makeSpace('STA-2', {trackerIssue: makeIssue('backlog', 'Backlog')}),
		makeSpace('STA-3', {trackerIssue: makeIssue('unstarted', 'Todo')}),
		makeSpace('STA-4', {trackerIssue: makeIssue('started', 'In Progress')}),
	];
	expect(findSpacesToAutoRemove(spaces, true)).toStrictEqual([]);
});

test('never returns the main worktree even if it somehow has a done issue', () => {
	const spaces: SpaceData[] = [
		makeSpace('main', {
			isMainWorktree: true,
			trackerIssue: makeIssue('completed', 'Done'),
		}),
	];
	expect(findSpacesToAutoRemove(spaces, true)).toStrictEqual([]);
});

test('never returns pending placeholder rows', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-99', {
			isPending: true,
			trackerIssue: makeIssue('completed', 'Done'),
		}),
	];
	expect(findSpacesToAutoRemove(spaces, true)).toStrictEqual([]);
});

test('skips spaces without a tracker issue', () => {
	const spaces: SpaceData[] = [makeSpace('STA-10')];
	expect(findSpacesToAutoRemove(spaces, true)).toStrictEqual([]);
});

test('also accepts the legacy linearIssue field', () => {
	const spaces: SpaceData[] = [
		makeSpace('STA-10', {linearIssue: makeIssue('completed', 'Done')}),
	];
	const result = findSpacesToAutoRemove(spaces, true);
	expect(result.length).toBe(1);
	expect(result[0]!.name).toBe('STA-10');
});

test('AUTO_REMOVE_STATE_TYPES contains exactly completed and canceled', () => {
	expect([...AUTO_REMOVE_STATE_TYPES].sort()).toStrictEqual([
		'canceled',
		'completed',
	]);
});

// ============================================================================
// Cross-provider: Jira issues must reach the same predicate (STA-2139)
// ============================================================================

test('finds a Jira space whose status category is Done', () => {
	const jiraIssue = mapJiraIssue({
		key: 'CHEX-1',
		fields: {
			summary: 'Shipped it',
			status: {name: 'Done', statusCategory: {key: 'done', name: 'Done'}},
		},
	});
	const spaces: SpaceData[] = [makeSpace('CHEX-1', {trackerIssue: jiraIssue})];
	const result = findDoneSpaces(spaces);
	expect(result.length).toBe(1);
	expect(result[0]!.name).toBe('CHEX-1');
});

test('leaves a Jira space alone while its status category is In Progress', () => {
	const jiraIssue = mapJiraIssue({
		key: 'CHEX-2',
		fields: {
			summary: 'Still going',
			status: {
				name: 'In Progress',
				statusCategory: {key: 'indeterminate', name: 'In Progress'},
			},
		},
	});
	const spaces: SpaceData[] = [makeSpace('CHEX-2', {trackerIssue: jiraIssue})];
	expect(findDoneSpaces(spaces)).toStrictEqual([]);
});

// ============================================================================
// A rail of several repos: each space answers for its own repo
// ============================================================================

const config = (autoRemove: boolean | undefined): PappardelleConfig => ({
	version: 1,
	profiles: {},
	...(autoRemove === undefined ? {} : {auto_remove_when_done: autoRemove}),
});

test('on a rail of several repos only the spaces of a repo with the flag on are removed', () => {
	const done = makeIssue('completed', 'Done');
	const spaces: SpaceData[] = [
		makeSpace('@work:main', {repo: '@work', isMainWorktree: true}),
		makeSpace('api:STA-1', {repo: 'api', trackerIssue: done}),
		makeSpace('api:STA-2', {
			repo: 'api',
			trackerIssue: makeIssue('started', 'In Progress'),
		}),
		makeSpace('web:STA-1', {repo: 'web', trackerIssue: done}),
		makeSpace('docs:DOC-4', {repo: 'docs', trackerIssue: done}),
	];
	// The work dir's own setting is on, web's is off, docs has no config that loads.
	const configs: Record<string, PappardelleConfig | null> = {
		'@work': config(true),
		api: config(true),
		web: config(false),
		docs: null,
	};
	const read: string[] = [];
	const removed = findRepoSpacesToAutoRemove(spaces, {
		configOf: space => configs[space.repo!] ?? null,
		currentConfig(space) {
			read.push(space.repo!);
			return {kind: 'valid', config: configs[space.repo!]!};
		},
	});
	expect(removed.map(space => space.name)).toStrictEqual(['api:STA-1']);
	// Only a repo with something to remove has its config read again.
	expect(read).toStrictEqual(['api']);
});

test('a repo whose config no longer loads keeps its done spaces, and the other repos lose theirs', () => {
	const done = makeIssue('canceled', 'Cancelled');
	const spaces: SpaceData[] = [
		makeSpace('api:STA-1', {repo: 'api', trackerIssue: done}),
		makeSpace('api:STA-2', {repo: 'api', trackerIssue: done}),
		makeSpace('web:WEB-9', {repo: 'web', trackerIssue: done}),
	];
	const read: string[] = [];
	const removed = findRepoSpacesToAutoRemove(spaces, {
		configOf: () => config(true),
		currentConfig(space) {
			read.push(space.repo!);
			return space.repo === 'api'
				? {kind: 'invalid', errors: ['profiles: must be a map']}
				: {kind: 'valid', config: config(true)};
		},
	});
	expect(removed.map(space => space.name)).toStrictEqual(['web:WEB-9']);
	expect(read).toStrictEqual(['api', 'web']);
});
