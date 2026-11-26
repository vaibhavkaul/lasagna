/* eslint-disable no-template-curly-in-string -- These are idow shell templates. */
// idow evals each setup step in its own shell, and stays that way for the
// steps a person wrote. This runs the steps setup writes through the real
// idow, to check that what setup does to them is enough.
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {stringify} from 'yaml';
import {setup} from '../../test/helpers/idow-fixture.ts';
import {parseRepoAnswer} from './answer.ts';

test('an exit or cd in a step setup inferred ends or moves only that step, not idow', async () => {
	const answer = parseRepoAnswer(
		JSON.stringify({
			values: [
				{
					key: 'post_workspace_init',
					value: [
						{name: 'Before', run: 'pwd > "${WORKTREE_PATH}/before"'},
						{name: 'Leave', run: 'cd / && exit 3'},
						{name: 'Move', run: 'cd /'},
						{name: 'After', run: 'pwd > "${WORKTREE_PATH}/after"'},
					],
					source: 'CLAUDE.md:3',
					confidence: 'high',
				},
			],
		}),
		'api',
	);
	if ('errors' in answer) throw new Error(answer.errors.join('\n'));
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({post_workspace_init: answer.values[0]!.value}),
	);

	const output = await fixture.run();

	expect(output.includes('Workspace test-abc is ready!'), output).toBe(true);
	expect(fs.existsSync(fixture.launchArgs)).toBe(true);
	const read = (file: string) =>
		fs.readFileSync(path.join(fixture.workspace, file), 'utf8').trim();
	expect(read('after')).toBe(read('before'));
	expect(read('after')).not.toBe('/');
});
