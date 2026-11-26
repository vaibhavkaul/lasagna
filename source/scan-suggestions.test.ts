import {test, expect} from 'bun:test';
import path from 'node:path';
import {writeFiles} from '../test/helpers/config-fixtures.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	issuePrefix,
	parseScanSuggestions,
	readScanSuggestions,
} from './scan-suggestions.ts';

// What `lasagna scan` writes, cut down to two prefixes.
const scan = {
	version: 1,
	workdir: '/work',
	repos: [{name: 'tts-business'}, {name: 'appian-server'}],
	prefixes: {
		B2B: {
			keys: 120,
			localKeys: 14,
			defaultRepo: 'tts-business',
			repos: {'appian-server': 0.31, 'tts-business': 0.62, consul: 0.07},
			localRepos: {'tts-business': 1},
		},
		PLAT: {
			keys: 40,
			localKeys: 0,
			defaultRepo: 'appian-server',
			repos: {'appian-server': 0.8, terraform: 0.2},
		},
	},
};

test('each prefix has its default repo and its repos, largest share first', () => {
	const suggestions = parseScanSuggestions(JSON.stringify(scan));
	expect([...suggestions.keys()]).toEqual(['B2B', 'PLAT']);
	expect(suggestions.get('B2B')).toEqual({
		defaultRepo: 'tts-business',
		repos: [
			{name: 'tts-business', share: 0.62},
			{name: 'appian-server', share: 0.31},
			{name: 'consul', share: 0.07},
		],
	});
	expect(suggestions.get('PLAT')?.defaultRepo).toBe('appian-server');
});

test('a file that is not a version 1 scan suggests nothing', () => {
	for (const content of [
		'',
		'not json',
		'[]',
		'null',
		JSON.stringify({...scan, version: 2}),
		JSON.stringify({version: 1}),
		JSON.stringify({version: 1, prefixes: []}),
	])
		expect(parseScanSuggestions(content).size).toBe(0);
});

test('a prefix that is not what scan writes is left out, and the rest are kept', () => {
	const suggestions = parseScanSuggestions(
		JSON.stringify({
			version: 1,
			prefixes: {
				BAD: 'nope',
				EMPTY: {repos: {}},
				ODD: {defaultRepo: 7, repos: {api: 'half', web: 0.5, none: 0}},
				plat: {defaultRepo: 'infra'},
			},
		}),
	);
	expect([...suggestions.keys()]).toEqual(['ODD', 'PLAT']);
	expect(suggestions.get('ODD')).toEqual({
		repos: [{name: 'web', share: 0.5}],
	});
	// A default with no shares still names the repo.
	expect(suggestions.get('PLAT')).toEqual({defaultRepo: 'infra', repos: []});
});

test('the scan is read from the work dir, and a work dir never scanned suggests nothing', () => {
	const work = tempDir('lasagna-scan-');
	expect(readScanSuggestions(work).size).toBe(0);
	writeFiles(work, {'.lasagna/scan.json': JSON.stringify(scan)});
	expect(readScanSuggestions(work).get('B2B')?.defaultRepo).toBe(
		'tts-business',
	);
	writeFiles(work, {'.lasagna/scan.json': '{"version": 1, "prefixes": '});
	expect(readScanSuggestions(work).size).toBe(0);
	expect(readScanSuggestions(path.join(work, 'missing')).size).toBe(0);
});

test('an issue key has a prefix, and other text has none', () => {
	expect(issuePrefix('B2B-3184')).toBe('B2B');
	expect(issuePrefix(' plat-5751 ')).toBe('PLAT');
	expect(issuePrefix('A1B-2')).toBe('A1B');
	for (const text of ['', '3184', 'fix B2B-3184', 'B2B-', 'B2B-12a', 'UTF-8 x'])
		expect(issuePrefix(text)).toBeUndefined();
});
