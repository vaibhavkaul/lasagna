import {test, expect} from 'bun:test';
import {
	formatSpaceRef,
	parseSpaceRef,
	resolveSpaceRef,
	spaceRefError,
} from './space-ref.ts';

const repos = ['@work', 'api', 'web'];

/** Spaces by repo, for a resolution that must not look anywhere else. */
function spaces(open: Record<string, string[]>) {
	const asked: string[] = [];
	return {
		asked,
		hasSpace(repo: string, key: string) {
			asked.push(formatSpaceRef(repo, key));
			return open[repo]?.includes(key) ?? false;
		},
	};
}

test('repo:KEY splits into its repo and key', () => {
	expect(parseSpaceRef('api:STA-12')).toEqual({repo: 'api', key: 'STA-12'});
	expect(parseSpaceRef('my.repo:main')).toEqual({repo: 'my.repo', key: 'main'});
	expect(parseSpaceRef('@work:main')).toEqual({repo: '@work', key: 'main'});
	expect(parseSpaceRef(formatSpaceRef('api', 'STA-12'))).toEqual({
		repo: 'api',
		key: 'STA-12',
	});
});

test('a bare key, a URL and text with spaces are not repo:KEY', () => {
	expect(parseSpaceRef('STA-12')).toEqual({key: 'STA-12'});
	expect(parseSpaceRef('696')).toEqual({key: '696'});
	const url = 'https://linear.app/team/issue/STA-12';
	expect(parseSpaceRef(url)).toEqual({key: url});
	expect(parseSpaceRef('fix: the thing')).toEqual({key: 'fix: the thing'});
});

test('repo:KEY names a space of another repo', () => {
	const {asked, hasSpace} = spaces({});
	expect(
		resolveSpaceRef('web:STA-1', {ownRepo: 'api', repos, hasSpace}),
	).toEqual({kind: 'other', repo: 'web', key: 'STA-1'});
	// Naming the repo needs no lookup: the verb reports a space it doesn't have.
	expect(asked).toEqual([]);
});

test('repo:KEY naming the repo the command runs in is that repo\u2019s key', () => {
	const {hasSpace} = spaces({});
	expect(
		resolveSpaceRef('api:STA-1', {ownRepo: 'api', repos, hasSpace}),
	).toEqual({kind: 'own', key: 'STA-1'});
});

test('repo:KEY with a repo the work dir does not list is an error naming the repos', () => {
	const {hasSpace} = spaces({});
	const resolution = resolveSpaceRef('nope:STA-1', {
		ownRepo: 'api',
		repos,
		hasSpace,
	});
	expect(resolution).toEqual({kind: 'unknown-repo', repo: 'nope', repos});
	if (resolution.kind === 'unknown-repo')
		expect(spaceRefError(resolution)).toBe(
			'No repo nope in this work dir. Repos: @work, api, web',
		);
});

test('a bare key belongs to the repo the command runs in when that repo has it', () => {
	const {hasSpace} = spaces({api: ['STA-1'], web: ['STA-1']});
	expect(resolveSpaceRef('STA-1', {ownRepo: 'api', repos, hasSpace})).toEqual({
		kind: 'own',
		key: 'STA-1',
	});
});

test('a single repo never looks a bare key up', () => {
	const {asked, hasSpace} = spaces({});
	expect(
		resolveSpaceRef('STA-1', {ownRepo: 'api', repos: ['api'], hasSpace}),
	).toEqual({kind: 'own', key: 'STA-1'});
	expect(asked).toEqual([]);
});

test('a bare key only another repo has is that repo\u2019s space', () => {
	const {hasSpace} = spaces({web: ['WEB-4']});
	expect(resolveSpaceRef('WEB-4', {ownRepo: 'api', repos, hasSpace})).toEqual({
		kind: 'other',
		repo: 'web',
		key: 'WEB-4',
	});
});

test('a bare key nothing has stays with the repo the command runs in', () => {
	const {hasSpace} = spaces({});
	expect(resolveSpaceRef('STA-9', {ownRepo: 'api', repos, hasSpace})).toEqual({
		kind: 'own',
		key: 'STA-9',
	});
});

test('a bare key several other repos have is ambiguous, and lists them', () => {
	const {hasSpace} = spaces({api: ['B2B-1'], web: ['B2B-1']});
	const resolution = resolveSpaceRef('B2B-1', {
		ownRepo: '@work',
		repos,
		hasSpace,
	});
	expect(resolution).toEqual({
		kind: 'ambiguous',
		key: 'B2B-1',
		matches: ['api:B2B-1', 'web:B2B-1'],
	});
	if (resolution.kind === 'ambiguous')
		expect(spaceRefError(resolution)).toBe(
			'B2B-1 is a space in more than one repo. Name one: api:B2B-1, web:B2B-1',
		);
});

test('outside every repo, a bare key nothing has is not found', () => {
	const {hasSpace} = spaces({});
	const resolution = resolveSpaceRef('STA-9', {repos, hasSpace});
	expect(resolution).toEqual({kind: 'not-found', key: 'STA-9', repos});
	if (resolution.kind === 'not-found')
		expect(spaceRefError(resolution)).toContain('repo:KEY');
});
