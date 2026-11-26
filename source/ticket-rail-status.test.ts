// PR status on a rail with ticket spaces: a ticket is asked about in each of
// its repos, by that repo's worktree, and shows them together.
import {test, expect, beforeEach} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {
	resetProviders,
	setRepoProviderSources,
	vcsHostFor,
} from './providers/index.ts';
import type {RailStatus} from './providers/types.ts';
import type {RepoContext} from './repo-context.ts';
import {parseSpaceRef} from './space-ref.ts';
import {
	combineRailStatuses,
	setSpaceScopes,
	setTicketMembers,
	spacesRailStatus,
	ticketMembers,
} from './space-scope.ts';

beforeEach(() => {
	resetProviders();
});

const context = (name: string): RepoContext => {
	const roots = {name, root: `/w/${name}`, mainRoot: `/w/${name}`};
	return roots as unknown as RepoContext;
};

const status = (
	pipeline: RailStatus['pipeline'],
	extra: Partial<RailStatus> = {},
): RailStatus => ({pipeline, unresolvedCommentCount: 0, ...extra});

test('several repos\u2019 statuses read as one: the pipeline furthest from passing, every comment, any conflict', () => {
	expect(
		combineRailStatuses([
			status('passing', {unresolvedCommentCount: 2, prNumber: 7}),
			status('progressing_clean', {unresolvedCommentCount: 1, prNumber: 9}),
			status(null, {unresolvedCommentCount: 5, hasConflict: true}),
		]),
	).toEqual({
		pipeline: 'progressing_clean',
		unresolvedCommentCount: 3,
		prNumber: 7,
		hasConflict: false,
	});
	expect(
		combineRailStatuses([
			status('progressing_dirty'),
			status('failing', {hasConflict: true}),
			status('passing'),
		]),
	).toEqual({
		pipeline: 'failing',
		unresolvedCommentCount: 0,
		hasConflict: true,
	});
	// No PR anywhere is no PR.
	expect(combineRailStatuses([status(null), status(null)])).toEqual({
		pipeline: null,
		unresolvedCommentCount: 0,
		hasConflict: false,
	});
});

/** A rail of two repos and their work dir, with one ticket space in both. */
function rail(answers: Record<string, Record<string, RailStatus> | 'down'>) {
	const repos = ['@work', 'api', 'web'].map(name => context(name));
	const asked: Array<{
		repo: string;
		keys: string[];
		paths: Array<[string, string]>;
	}> = [];
	for (const repo of repos) {
		setRepoProviderSources(repo.name, {});
		vcsHostFor(repo.name).getBulkRailStatus = async (keys, paths) => {
			asked.push({repo: repo.name, keys: [...keys], paths: [...(paths ?? [])]});
			const mine = answers[repo.name];
			// A host that cannot answer says nothing of any key.
			if (mine === undefined || mine === 'down') return new Map();
			return new Map(
				keys.flatMap(key => (mine[key] ? [[key, mine[key]]] : [])),
			);
		};
	}

	setSpaceScopes(name => {
		const ref = parseSpaceRef(name);
		const repo = repos.find(each => each.name === ref.repo);
		return repo && {repo, key: ref.key};
	});
	setTicketMembers(name =>
		name === '@work:B2B-5'
			? [
					{repo: repos[1]!, worktreePath: '/tickets/B2B-5/api'},
					{repo: repos[2]!, worktreePath: '/tickets/B2B-5/web'},
				]
			: undefined,
	);
	teardown(() => {
		setSpaceScopes(undefined);
		setTicketMembers(undefined);
	});
	return asked;
}

test('a ticket space is asked about in each of its repos, by that repo\u2019s worktree', async () => {
	const asked = rail({
		api: {
			'STA-1': status('passing', {prNumber: 3}),
			'B2B-5': status('failing', {prNumber: 41, unresolvedCommentCount: 2}),
		},
		web: {'B2B-5': status('passing', {prNumber: 8})},
	});
	expect(ticketMembers('api:STA-1')).toBeUndefined();
	const statuses = await spacesRailStatus(
		['api:STA-1', '@work:B2B-5'],
		new Map([
			['api:STA-1', '/worktrees/api/STA-1'],
			['@work:B2B-5', '/tickets/B2B-5'],
		]),
	);
	// One request per repo: a repo's plain spaces and its part in tickets.
	expect(asked.sort((a, b) => a.repo.localeCompare(b.repo))).toEqual([
		{
			repo: 'api',
			keys: ['STA-1', 'B2B-5'],
			paths: [
				['STA-1', '/worktrees/api/STA-1'],
				['B2B-5', '/tickets/B2B-5/api'],
			],
		},
		{repo: 'web', keys: ['B2B-5'], paths: [['B2B-5', '/tickets/B2B-5/web']]},
	]);
	expect(statuses.get('api:STA-1')).toEqual(status('passing', {prNumber: 3}));
	expect(statuses.get('@work:B2B-5')).toEqual({
		pipeline: 'failing',
		unresolvedCommentCount: 2,
		prNumber: 41,
		hasConflict: false,
		repos: [
			{
				repo: 'api',
				status: status('failing', {prNumber: 41, unresolvedCommentCount: 2}),
			},
			{repo: 'web', status: status('passing', {prNumber: 8})},
		],
	});
});

test('a repo whose host cannot answer is left out, and no answer at all changes nothing', async () => {
	rail({api: 'down', web: {'B2B-5': status('progressing_clean')}});
	const partial = await spacesRailStatus(['@work:B2B-5'], new Map());
	expect(partial.get('@work:B2B-5')?.repos).toEqual([
		{repo: 'web', status: status('progressing_clean')},
	]);

	rail({api: 'down', web: 'down'});
	const none = await spacesRailStatus(['@work:B2B-5'], new Map());
	expect(none.size).toBe(0);
});
