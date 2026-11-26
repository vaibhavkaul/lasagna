import {test, expect} from 'bun:test';
import {press} from '../test/helpers/key-press.ts';
import {
	defaultRepoIndex,
	formatShare,
	pickedRepos,
	repoChoices,
	repoPickerStep,
	repoPickerWindow,
	toggleRepo,
} from './repo-picker.ts';
import {parseScanSuggestions} from './scan-suggestions.ts';

test('j, k and the arrows move within the list', () => {
	expect(repoPickerStep(press('j'), 0, 3)).toEqual({kind: 'move', index: 1});
	expect(repoPickerStep(press('down'), 1, 3)).toEqual({kind: 'move', index: 2});
	expect(repoPickerStep(press('down'), 2, 3)).toEqual({kind: 'move', index: 2});
	expect(repoPickerStep(press('k'), 2, 3)).toEqual({kind: 'move', index: 1});
	expect(repoPickerStep(press('up'), 0, 3)).toEqual({kind: 'move', index: 0});
});

test('Enter picks the highlighted repo and a digit picks its row', () => {
	expect(repoPickerStep(press('return'), 1, 3)).toEqual({
		kind: 'pick',
		index: 1,
	});
	expect(repoPickerStep(press('3'), 0, 3)).toEqual({kind: 'pick', index: 2});
	// A digit past the list picks nothing.
	expect(repoPickerStep(press('4'), 0, 3)).toEqual({kind: 'ignore'});
	expect(repoPickerStep(press('0'), 0, 3)).toEqual({kind: 'ignore'});
});

test('Escape and q leave without picking, and other keys do nothing', () => {
	expect(repoPickerStep(press('escape'), 1, 3)).toEqual({kind: 'cancel'});
	expect(repoPickerStep(press('q'), 1, 3)).toEqual({kind: 'cancel'});
	expect(repoPickerStep(press('x'), 1, 3)).toEqual({kind: 'ignore'});
	expect(repoPickerStep(press('return'), 0, 0)).toEqual({kind: 'ignore'});
	expect(repoPickerStep(press('escape'), 0, 0)).toEqual({kind: 'cancel'});
});

test('the list opens on the selected space\u2019s repo, else the last one used, else the first', () => {
	const repos = ['api', 'web', 'data'];
	expect(defaultRepoIndex(repos, 'web', 'data')).toBe(1);
	// The root main space is in no repo of the list.
	expect(defaultRepoIndex(repos, '@work', 'data')).toBe(2);
	expect(defaultRepoIndex(repos, undefined, undefined)).toBe(0);
	expect(defaultRepoIndex(repos, 'gone', 'gone-too')).toBe(0);
});

test('a list longer than its room keeps the highlighted row in view', () => {
	expect(repoPickerWindow(4, 0, 10)).toEqual({start: 0, end: 4});
	expect(repoPickerWindow(25, 0, 5)).toEqual({start: 0, end: 5});
	expect(repoPickerWindow(25, 12, 5)).toEqual({start: 10, end: 15});
	expect(repoPickerWindow(25, 24, 5)).toEqual({start: 20, end: 25});
	// A dialog with no room still shows the highlighted row.
	expect(repoPickerWindow(25, 7, 0)).toEqual({start: 7, end: 8});
});

test('Space ticks the highlighted row, and Enter picks the ticked rows in list order', () => {
	expect(repoPickerStep(press('space'), 2, 3)).toEqual({
		kind: 'toggle',
		index: 2,
	});
	const names = ['api', 'web', 'data'];
	let ticked = toggleRepo(new Set(), 2);
	ticked = toggleRepo(ticked, 0);
	expect(pickedRepos(names, ticked, 1)).toEqual(['api', 'data']);
	// Ticking a row again unticks it, and with none ticked Enter picks the
	// highlighted row alone.
	ticked = toggleRepo(toggleRepo(ticked, 0), 2);
	expect(pickedRepos(names, ticked, 1)).toEqual(['web']);
	expect(pickedRepos([], new Set(), 0)).toEqual([]);
});

const scan = parseScanSuggestions(
	JSON.stringify({
		version: 1,
		prefixes: {
			B2B: {
				defaultRepo: 'web',
				repos: {api: 0.3, web: 0.62, gone: 0.08},
			},
			PLAT: {defaultRepo: 'infra', repos: {infra: 0.7, api: 0.3}},
		},
	}),
);
const repos = ['api', 'web', 'data', 'infra'];

test('an issue key leads with the repos its prefix is worked on in, largest share first, and opens on the default repo', () => {
	const b2b = repoChoices({repos, input: 'B2B-3184', suggestions: scan});
	expect(b2b.prefix).toBe('B2B');
	expect(b2b.rows).toEqual([
		{name: 'web', share: 0.62, suggested: true},
		{name: 'api', share: 0.3, suggested: true},
		// The rest in the work dir's order; a repo scan knew that the work dir
		// no longer lists is left out.
		{name: 'data', suggested: false},
		{name: 'infra', suggested: false},
	]);
	expect(b2b.rows[b2b.defaultIndex]!.name).toBe('web');

	const plat = repoChoices({
		repos,
		input: ' plat-5751 ',
		suggestions: scan,
		// The key's own repo wins over the one last worked in.
		selected: 'data',
		lastUsed: 'web',
	});
	expect(plat.rows.map(row => row.name)).toEqual([
		'infra',
		'api',
		'web',
		'data',
	]);
	expect(plat.rows[plat.defaultIndex]!.name).toBe('infra');
});

test('the default repo need not have the largest share', () => {
	const suggestions = parseScanSuggestions(
		JSON.stringify({
			version: 1,
			prefixes: {B2B: {defaultRepo: 'api', repos: {web: 0.7, api: 0.3}}},
		}),
	);
	const choices = repoChoices({repos, input: 'B2B-1', suggestions});
	expect(choices.rows.map(row => row.name).slice(0, 2)).toEqual(['web', 'api']);
	expect(choices.rows[choices.defaultIndex]!.name).toBe('api');
});

test('free text and an unknown prefix keep the work dir\u2019s order and the last repo used', () => {
	for (const input of ['fix the login', 'ZZZ-1', '']) {
		const choices = repoChoices({
			repos,
			input,
			suggestions: scan,
			lastUsed: 'data',
		});
		expect(choices.rows.map(row => row.name)).toEqual(repos);
		expect(choices.rows.every(row => !row.suggested)).toBe(true);
		expect(choices.rows[choices.defaultIndex]!.name).toBe('data');
	}

	// The selected space's repo comes before the last one used.
	const choices = repoChoices({
		repos,
		input: 'fix it',
		suggestions: scan,
		selected: 'infra',
		lastUsed: 'data',
	});
	expect(choices.rows[choices.defaultIndex]!.name).toBe('infra');
	expect(choices.prefix).toBeUndefined();
});

test('without a scan, the repos whose own config names the prefix are suggested', () => {
	const declared = (prefix: string) =>
		prefix === 'PLAT' ? ['infra', 'api', 'elsewhere'] : [];
	const choices = repoChoices({
		repos,
		input: 'PLAT-9',
		suggestions: new Map(),
		declared,
		lastUsed: 'api',
	});
	expect(choices.rows).toEqual([
		{name: 'infra', suggested: true},
		{name: 'api', suggested: true},
		{name: 'web', suggested: false},
		{name: 'data', suggested: false},
	]);
	// Among the suggested, the one last worked in.
	expect(choices.rows[choices.defaultIndex]!.name).toBe('api');
	// Last worked in a repo the prefix is not for: the first suggested one.
	const other = repoChoices({
		repos,
		input: 'PLAT-9',
		suggestions: new Map(),
		declared,
		lastUsed: 'data',
	});
	expect(other.rows[other.defaultIndex]!.name).toBe('infra');
	// The scan, when it knows the prefix, is what counts.
	const scanned = repoChoices({
		repos,
		input: 'PLAT-9',
		suggestions: scan,
		declared: () => ['data'],
	});
	expect(scanned.rows[0]).toEqual({name: 'infra', share: 0.7, suggested: true});
});

test('a share reads as a whole percent', () => {
	expect(formatShare(0.62)).toBe('62%');
	expect(formatShare(1)).toBe('100%');
	expect(formatShare(0.004)).toBe('<1%');
});
