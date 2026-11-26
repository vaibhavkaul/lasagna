import {spawnSync} from 'node:child_process';
import {describe, test, expect} from 'bun:test';
import {
	KEY_SPECS,
	inSubshell,
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

function accepted(text: string): {values: InferredValue[]; notes: string[]} {
	const parsed = parseRepoAnswer(text, 'api');
	if ('errors' in parsed) throw new Error(parsed.errors.join('\n'));
	return parsed;
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
					value: [
						{
							name: 'Install',
							run: '( yarn install --frozen-lockfile )',
							continue_on_error: true,
						},
					],
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

	test('a key setup does not infer is left out with a note, and the rest kept', () => {
		const parsed = accepted(
			answer([
				value('team_prefix', 'B2B'),
				value('claude.dangerously_skip_permissions', true),
				// Another profile than the repo's.
				value('profiles.web.display_name', 'Web'),
			]),
		);
		expect(parsed.values.map(held => held.path.join('.'))).toStrictEqual([
			'team_prefix',
		]);
		expect(parsed.notes).toStrictEqual([
			'left out "claude.dangerously_skip_permissions" is not a key setup infers',
			'left out "profiles.web.display_name" is not a key setup infers',
		]);
	});

	test('a value of the wrong shape is left out, naming the key and why', () => {
		const cases: Array<[string, unknown, string]> = [
			['team_prefix', 'b2b', 'team_prefix: must be an upper-case project key'],
			['issue_tracker.provider', 'github', 'issue_tracker.provider: must be'],
			['issue_tracker.base_url', 'acme.atlassian.net', 'must be a URL'],
			['issue_tracker.base_url', 'ftp://acme', 'must be an http(s) URL'],
			['post_workspace_init', [], 'must be a non-empty list of commands'],
			[
				'post_workspace_init',
				[{name: 'x', run: 'true', shell: 'zsh'}],
				'[0].shell is not a command field',
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
			const parsed = accepted(answer([value(key, held)]));
			expect(parsed.values, `${key} ${JSON.stringify(held)}`).toStrictEqual([]);
			expect(
				parsed.notes.join('\n'),
				`${key} ${JSON.stringify(held)}`,
			).toContain(message);
		}
	});

	test('a value needs a source and a known confidence; a source over lines is folded onto one', () => {
		const parsed = accepted(
			answer([
				{key: 'team_prefix', value: 'B2B', source: '', confidence: 'sure'},
				{
					key: 'issue_tracker.provider',
					value: 'jira',
					source: 'README.md:3\n  and CLAUDE.md:9',
					confidence: 'high',
				},
			]),
		);
		expect(parsed.notes).toStrictEqual([
			'left out team_prefix: source must be a non-empty string; confidence must be one of high, medium, low',
		]);
		expect(parsed.values.map(held => held.source)).toStrictEqual([
			'README.md:3 and CLAUDE.md:9',
		]);
	});

	test('an answer of the wrong shape is refused as a whole', () => {
		expect(
			errorsOf(
				JSON.stringify({
					values: [
						value('team_prefix', 'B2B'),
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
			'values[1].key team_prefix is given twice',
			'values[2] must be an object',
		]);
		expect(errorsOf('{"notes": []}')).toStrictEqual(['values must be a list']);
	});

	test('a field outside a value leaves that value out', () => {
		expect(
			accepted(answer([{...value('team_prefix', 'B2B'), why: 'x'}])).notes,
		).toStrictEqual(['left out team_prefix: why is not part of a value']);
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

	test('inferred setup steps never block a space from opening unless they say so', () => {
		const parsed = accepted(
			answer([
				value('post_workspace_init', [
					{name: 'Unlock', run: 'git-crypt unlock; exit $?'},
					{name: 'Must pass', run: 'make', continue_on_error: false},
				]),
			]),
		);
		expect(parsed.values[0]!.value).toStrictEqual([
			{
				name: 'Unlock',
				run: '( git-crypt unlock; exit $? )',
				continue_on_error: true,
			},
			{name: 'Must pass', run: '( make )', continue_on_error: false},
		]);
	});

	test('an inferred setup step runs in a subshell, once, with the closing parenthesis out of reach of a comment', () => {
		const parsed = accepted(
			answer([
				value(
					'post_workspace_init',
					[
						'cd app && yarn install',
						'  ( cd app && make )  ',
						'(cd a) && (cd b)',
						'(echo ")" ) ; exit 1 ; (echo "(")',
						'mise trust # tool versions',
						'cat > .env <<EOF\nA=1\nEOF',
					].map(run => ({name: 'Step', run})),
				),
			]),
		);
		expect(
			(parsed.values[0]!.value as Array<{run: string}>).map(step => step.run),
		).toStrictEqual([
			'( cd app && yarn install )',
			'( cd app && make )',
			'( (cd a) && (cd b) )',
			'( (echo ")" ) ; exit 1 ; (echo "(") )',
			'(\nmise trust # tool versions\n)',
			'(\ncat > .env <<EOF\nA=1\nEOF\n)',
		]);
	});

	test('what the subshell is for: an exit or a cd in a step leaves the shell that evals it running, where it was', () => {
		const shell = (run: string) =>
			spawnSync(
				'bash',
				['-c', 'cd /tmp; eval "$1"; printf "%s after" "$PWD"', 'bash', run],
				{encoding: 'utf8'},
			).stdout;
		const step = 'cd / && exit 3';
		expect(shell(step)).toBe('');
		expect(shell(inSubshell(step))).toBe('/tmp after');
		expect(shell(inSubshell('cd / # and stay\nexit 3'))).toBe('/tmp after');
	});
});
