import {describe, test, expect} from 'bun:test';
import {
	KEY_SPECS,
	keyFor,
	mergeValues,
	parseRepoAnswer,
	type InferredValue,
} from './answer.ts';

function answer(values: unknown[], notes?: unknown): string {
	return JSON.stringify({values, ...(notes === undefined ? {} : {notes})});
}

function value(key: string, held: unknown, confidence = 'high') {
	return {key, value: held, source: 'CLAUDE.md:3', confidence};
}

function errorsOf(text: string): string[] {
	const parsed = parseRepoAnswer(text, 'api');
	if (!('errors' in parsed)) throw new Error('the answer was accepted');
	return parsed.errors;
}

describe('a repo answer', () => {
	test('each value becomes a config path with its source and confidence', () => {
		const parsed = parseRepoAnswer(
			answer(
				[
					value('team_prefix', 'B2B'),
					value('issue_tracker.provider', 'jira', 'medium'),
					value('profiles.api.vars.PR_TEMPLATE', '.github/pr.md', 'low'),
					value('post_workspace_init', [
						{name: 'Install', run: 'yarn install --frozen-lockfile'},
					]),
				],
				['PLAT tickets moved to AP'],
			),
			'api',
		);
		expect(parsed).toStrictEqual({
			values: [
				{
					path: ['team_prefix'],
					value: 'B2B',
					source: 'CLAUDE.md:3',
					confidence: 'high',
				},
				{
					path: ['issue_tracker', 'provider'],
					value: 'jira',
					source: 'CLAUDE.md:3',
					confidence: 'medium',
				},
				{
					path: ['profiles', 'api', 'vars', 'PR_TEMPLATE'],
					value: '.github/pr.md',
					source: 'CLAUDE.md:3',
					confidence: 'low',
				},
				{
					path: ['post_workspace_init'],
					value: [{name: 'Install', run: 'yarn install --frozen-lockfile'}],
					source: 'CLAUDE.md:3',
					confidence: 'high',
				},
			],
			notes: ['PLAT tickets moved to AP'],
		});
	});

	test('the object is found inside a code fence or after a sentence', () => {
		const json = answer([value('team_prefix', 'B2B')]);
		for (const text of [
			`\`\`\`json\n${json}\n\`\`\``,
			`Here is what I found.\n\n\`\`\`json\n${json}\n\`\`\`\n`,
			`Here it is: ${json}`,
		]) {
			expect(parseRepoAnswer(text, 'api'), text).toMatchObject({
				values: [{path: ['team_prefix'], value: 'B2B'}],
				notes: [],
			});
		}
	});

	test('text that holds no JSON object is refused', () => {
		expect(errorsOf('I could not read the repo.')[0]).toStartWith(
			'the answer is not JSON:',
		);
		expect(errorsOf('{"values": [')[0]).toStartWith('the answer is not JSON:');
		expect(errorsOf('[1, 2]')).toStrictEqual([
			'the answer must be a JSON object',
		]);
	});

	test('a key setup does not infer makes the whole answer invalid', () => {
		expect(
			errorsOf(
				answer([
					value('team_prefix', 'B2B'),
					value('claude.dangerously_skip_permissions', true),
					// Another profile than the repo's.
					value('profiles.web.display_name', 'Web'),
				]),
			),
		).toStrictEqual([
			'values[1].key "claude.dangerously_skip_permissions" is not a key setup infers',
			'values[2].key "profiles.web.display_name" is not a key setup infers',
		]);
	});

	test('a value of the wrong shape is refused, naming the key', () => {
		const cases: Array<[string, unknown, string]> = [
			['team_prefix', 'b2b', 'team_prefix must be an upper-case project key'],
			['issue_tracker.provider', 'github', 'issue_tracker.provider must be'],
			['issue_tracker.base_url', 'acme.atlassian.net', 'must be a URL'],
			['issue_tracker.base_url', 'ftp://acme', 'must be an http(s) URL'],
			['post_workspace_init', [], 'must be a non-empty list of commands'],
			[
				'post_workspace_init',
				[{name: 'x', run: 'true', shell: 'zsh'}],
				'post_workspace_init [0].shell is not a command field',
			],
			[
				'post_workspace_init',
				[{name: 'x', run: ''}],
				'[0].run must be a non-empty string',
			],
			['profiles.api.keywords', ['ok', 3], 'must list non-empty single-line'],
			['profiles.api.tracker_projects', ['Plat'], 'upper-case project keys'],
			['profiles.api.vars.PR_TITLE_FORMAT', 'a\nb', 'must be a single line'],
		];
		for (const [key, held, message] of cases) {
			const errors = errorsOf(answer([value(key, held)]));
			expect(errors.join('\n'), `${key} ${JSON.stringify(held)}`).toContain(
				message,
			);
		}
	});

	test('a value needs a one-line source and a known confidence', () => {
		expect(
			errorsOf(
				answer([
					{key: 'team_prefix', value: 'B2B', source: '', confidence: 'sure'},
				]),
			),
		).toStrictEqual([
			'team_prefix: source must be a non-empty string',
			'team_prefix: confidence must be one of high, medium, low',
		]);
	});

	test('fields outside the shape, repeats and bad notes are refused', () => {
		expect(
			errorsOf(
				JSON.stringify({
					values: [
						{...value('team_prefix', 'B2B'), why: 'x'},
						value('team_prefix', 'PLAT'),
						'team_prefix',
					],
					notes: 'none',
					summary: 'x',
				}),
			),
		).toStrictEqual([
			'summary is not part of the answer',
			'notes must be a list of single-line strings',
			'values[0].why is not part of a value',
			'values[1].key team_prefix is given twice',
			'values[2] must be an object',
		]);
		expect(errorsOf('{"notes": []}')).toStrictEqual(['values must be a list']);
	});
});

describe('the keys setup infers', () => {
	test('a profile key is spelled with the repo profile', () => {
		const keys = KEY_SPECS.map(spec => keyFor(spec, 'api'));
		expect(keys).toContain('profiles.api.tracker_projects');
		expect(keys.some(key => key.includes('<profile>'))).toBe(false);
	});

	test('a later value replaces an earlier one with the same key', () => {
		const from = (source: string, held: string): InferredValue => ({
			path: ['team_prefix'],
			value: held,
			source,
			confidence: 'low',
		});
		const other: InferredValue = {...from('scan', 'x'), path: ['version']};
		expect(
			mergeValues([from('scan', 'B2B'), other], [from('claude', 'PLAT')]),
		).toStrictEqual([from('claude', 'PLAT'), other]);
	});
});
