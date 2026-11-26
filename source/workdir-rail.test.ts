import {test, expect} from 'bun:test';
import {
	isSelectableRow,
	nextSelectableRow,
	resolveCursorRow,
	splitAgentRows,
	type RailRow,
} from './rail-groups.ts';
import type {SpaceData} from './types.ts';
import {
	buildWorkdirRailRows,
	isRepoMainSpace,
	isRootMainSpace,
	nextWorkdirGrouping,
	workdirRowLabel,
} from './workdir-rail.ts';

const REPOS = ['api', 'web'];

function space(
	repo: string,
	key: string,
	extra: Partial<SpaceData> = {},
): SpaceData {
	return {name: `${repo}:${key}`, repo, key, worktreePath: null, ...extra};
}

const rootMain = space('@work', 'main', {isMainWorktree: true});
const apiMain = space('api', 'main', {isMainWorktree: true});
const webMain = space('web', 'main', {isMainWorktree: true});

/** A two-repo rail with the root main space, as the refresh orders it. */
const twoRepos: SpaceData[] = [
	rootMain,
	apiMain,
	space('api', 'B2B-12'),
	space('api', 'API-7'),
	webMain,
	space('web', 'B2B-12'),
	space('web', 'WEB-30'),
];

function shape(rows: readonly RailRow[]): string[] {
	return rows.map(row => {
		if (row.kind === 'header') {
			const fold =
				row.folded === undefined ? '' : row.folded ? ' [folded]' : ' [open]';
			return `# ${row.group.name} (${row.count})${fold}`;
		}

		return `${row.kind === 'pending' ? '~' : ' '} ${row.space.name}`;
	});
}

const rows = (
	options: Partial<Parameters<typeof buildWorkdirRailRows>[0]> = {},
) =>
	buildWorkdirRailRows({
		displaySpaces: twoRepos,
		grouping: 'repo',
		repos: REPOS,
		mainsFolded: false,
		...options,
	});

test('grouped by repo: the root main space, the repos\u2019 main spaces, then each repo over its spaces', () => {
	expect(shape(rows())).toEqual([
		'  @work:main',
		'# repos (2) [open]',
		'  api:main',
		'  web:main',
		'# api (2)',
		'  api:B2B-12',
		'  api:API-7',
		'# web (2)',
		'  web:B2B-12',
		'  web:WEB-30',
	]);
});

test('repos keep the order the work dir lists them in, whatever order their spaces arrive in', () => {
	const shuffled = [...twoRepos].reverse();
	expect(shape(rows({displaySpaces: shuffled, repos: ['web', 'api']}))).toEqual(
		[
			'  @work:main',
			'# repos (2) [open]',
			'  web:main',
			'  api:main',
			'# web (2)',
			'  web:WEB-30',
			'  web:B2B-12',
			'# api (2)',
			'  api:API-7',
			'  api:B2B-12',
		],
	);
});

test('a repo with no space has a main space and no group', () => {
	const noWebSpaces = twoRepos.filter(
		each => each.repo !== 'web' || each.isMainWorktree,
	);
	expect(shape(rows({displaySpaces: noWebSpaces}))).toEqual([
		'  @work:main',
		'# repos (2) [open]',
		'  api:main',
		'  web:main',
		'# api (2)',
		'  api:B2B-12',
		'  api:API-7',
	]);
});

test('grouped by ticket: a key is one header over every repo that has it, newest first', () => {
	expect(shape(rows({grouping: 'ticket'}))).toEqual([
		'  @work:main',
		'# repos (2) [open]',
		'  api:main',
		'  web:main',
		'# WEB-30 (1)',
		'  web:WEB-30',
		'# B2B-12 (2)',
		'  api:B2B-12',
		'  web:B2B-12',
		'# API-7 (1)',
		'  api:API-7',
	]);
});

test('the repos\u2019 main spaces fold under their header, and the root main space never does', () => {
	expect(shape(rows({mainsFolded: true}))).toEqual([
		'  @work:main',
		'# repos (2) [folded]',
		'# api (2)',
		'  api:B2B-12',
		'  api:API-7',
		'# web (2)',
		'  web:B2B-12',
		'  web:WEB-30',
	]);
});

test('without headers the order holds and nothing is hidden: there is no header to unfold', () => {
	expect(shape(rows({headers: false, mainsFolded: true}))).toEqual([
		'  @work:main',
		'  api:main',
		'  web:main',
		'  api:B2B-12',
		'  api:API-7',
		'  web:B2B-12',
		'  web:WEB-30',
	]);
});

test('a space being started leads its repo\u2019s group', () => {
	const starting = space('web', 'WEB-31', {isPending: true});
	expect(
		shape(rows({displaySpaces: [...twoRepos, starting]})).slice(-4),
	).toEqual(['# web (3)', '~ web:WEB-31', '  web:B2B-12', '  web:WEB-30']);
});

test('on the ticket rail a space started from a description waits above the tickets', () => {
	const described: SpaceData = {
		name: '',
		repo: 'web',
		key: '',
		worktreePath: null,
		isPending: true,
		pendingTitle: 'Starting…',
	};
	const built = shape(
		rows({grouping: 'ticket', displaySpaces: [...twoRepos, described]}),
	);
	expect(built.slice(3, 6)).toEqual(['  web:main', '~ ', '# WEB-30 (1)']);
	// On the repo rail it is one of its repo's.
	expect(shape(rows({displaySpaces: [...twoRepos, described]})).at(-3)).toBe(
		'~ ',
	);
});

test('only the root main space leads the rail as an agent row; the repos\u2019 scroll with the list', () => {
	const {agents, spaces} = splitAgentRows(rows());
	expect(shape(agents)).toEqual(['  @work:main']);
	expect(shape(spaces)[0]).toBe('# repos (2) [open]');
});

test('j and k walk the spaces of every repo and step over the headers', () => {
	const built = rows();
	const walked: string[] = [];
	for (
		let at = resolveCursorRow(built, rootMain);
		at !== -1;
		at = nextSelectableRow(built, at, 1)
	) {
		expect(isSelectableRow(built[at])).toBe(true);
		const row = built[at]!;
		if (row.kind !== 'header') walked.push(row.space.name);
	}

	expect(walked).toEqual([
		'@work:main',
		'api:main',
		'web:main',
		'api:B2B-12',
		'api:API-7',
		'web:B2B-12',
		'web:WEB-30',
	]);
});

test('the root main space and a repo\u2019s main space are told apart by the pseudo-repo', () => {
	expect(isRootMainSpace(rootMain)).toBe(true);
	expect(isRepoMainSpace(rootMain)).toBe(false);
	expect(isRepoMainSpace(apiMain)).toBe(true);
	expect(isRootMainSpace(apiMain)).toBe(false);
	expect(isRepoMainSpace(space('api', 'API-7'))).toBe(false);
});

test('a row is called by its key, a repo\u2019s main space by the repo, the root by the sous-chef', () => {
	expect(workdirRowLabel(space('api', 'API-7'), 'chef')).toBe('API-7');
	expect(workdirRowLabel(apiMain, 'chef')).toBe('api');
	expect(workdirRowLabel(rootMain, 'chef')).toBe('chef');
	expect(workdirRowLabel(rootMain, undefined)).toBe('main');
});

test('the grouping key flips between repo and ticket', () => {
	expect(nextWorkdirGrouping('repo')).toBe('ticket');
	expect(nextWorkdirGrouping('ticket')).toBe('repo');
});
