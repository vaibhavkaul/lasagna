import {describe, test, expect} from 'bun:test';
import type {RepoScan} from '../workdir-scan.ts';
import {prefixProfiles, proposedValues, type RepoProposal} from './command.ts';

function repo(localKeys: Record<string, number>): RepoScan {
	const prefixes = Object.fromEntries(
		Object.entries(localKeys).map(([prefix, local]) => [
			prefix,
			{
				keys: 40,
				localKeys: local,
				branches: 10,
				commits: 10,
				prs: 10,
				examples: [],
			},
		]),
	);
	return {name: 'api', tickets: {prefixes}} as unknown as RepoScan;
}

const keys = (values: Array<{path: string[]; value: unknown}>) =>
	Object.fromEntries(values.map(({path, value}) => [path.join('.'), value]));

describe('a profile per prefix you work on', () => {
	test('each prefix your local branches use gets a profile, most used first', () => {
		const values = prefixProfiles(repo({B2B: 5, TTS: 1, WAL: 0}), undefined);

		expect(keys(values)).toStrictEqual({
			'profiles.b2b.display_name': 'B2B',
			'profiles.b2b.team_prefix': 'B2B',
			'profiles.b2b.tracker_projects': ['B2B'],
			'profiles.tts.display_name': 'TTS',
			'profiles.tts.team_prefix': 'TTS',
			'profiles.tts.tracker_projects': ['TTS'],
		});
		expect(values[0]!.confidence).toBe('high');
		expect(values.at(-1)!.confidence).toBe('medium');
	});

	test('one prefix of your own needs no profiles beyond the repo one', () => {
		expect(prefixProfiles(repo({B2B: 9, WAL: 0}), undefined)).toStrictEqual([]);
	});

	test("a prefix the repo's own config has a profile for is left to it", () => {
		const own = {
			file: '.pappardelle.yml',
			config: {profiles: {wallet: {team_prefix: 'WAL'}}},
		};

		const values = prefixProfiles(repo({B2B: 4, WAL: 4}), own);

		expect(Object.keys(keys(values))).toStrictEqual([
			'profiles.b2b.display_name',
			'profiles.b2b.team_prefix',
			'profiles.b2b.tracker_projects',
		]);
	});

	test("a prefix with its own profile leaves the repo profile's tracker_projects", () => {
		const proposal = {
			repo: repo({}),
			profile: 'api',
			defaults: prefixProfiles(repo({B2B: 4, TTS: 4}), undefined),
			learned: [
				{
					path: ['profiles', 'api', 'tracker_projects'],
					value: ['B2B', 'TTS', 'PAYM'],
					source: 'scan',
					confidence: 'high',
				},
			],
			notes: [],
			problems: [],
		} as unknown as RepoProposal;

		expect(
			keys(proposedValues(proposal))['profiles.api.tracker_projects'],
		).toStrictEqual(['PAYM']);
	});
});
