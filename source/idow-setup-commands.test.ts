/* eslint-disable no-template-curly-in-string -- These are idow shell templates. */
import {Database} from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {parse, stringify} from 'yaml';
import {sqliteRun} from '../test/helpers/state.ts';
import {setup} from '../test/helpers/idow-fixture.ts';

test('setup leaves merging config to the binary and does not resolve the terminal', async () => {
	const fixture = setup();
	await fixture.run();
	const calls = fs.readFileSync(fixture.configCalls, 'utf8').split('\n');
	// The binary merges every layer (state-cli merged-config); yq only reads the result.
	expect(calls.filter(call => call === 'eval-all').length).toBe(0);
	expect(calls.some(call => call.includes('.terminal.app'))).toBe(false);
});

test('opening without PR consumers skips VCS lookup', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({profiles: {dev: {links: []}}}),
	);
	const output = await fixture.run({open: true});
	expect(fs.existsSync(fixture.vcsCalls)).toBe(false);
	expect(fs.existsSync(fixture.launchArgs)).toBe(true);
	expect(output.includes('PR:')).toBe(false);
	expect(output.includes('Skipping PR/MR lookup'), output).toBe(true);
});

test('newly created issues launch fresh; existing keys keep conversation resume', async () => {
	const fixture = setup();
	const resumeArgs = () => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf('--agent-resume-args') + 1];
	};
	await fixture.run({input: 'Make workspace startup faster'});
	expect(resumeArgs()).toBe('');
	await fixture.run();
	expect(resumeArgs()).toBe('--continue');
});

// A tracker can hand a new issue the key of one that was deleted. The agent
// of the new issue must not resume the old one's conversation.
test('a new issue drops the sessions recorded under its key; an existing one keeps them', async () => {
	const fixture = setup();
	const stateDir = path.join(fixture.home, '.lasagna');
	const sessionsPath = path.join(
		stateDir,
		'repos/main checkout/space-state/test-abc.agent-sessions.json',
	);
	const record = () => {
		fs.mkdirSync(path.dirname(sessionsPath), {recursive: true});
		fs.writeFileSync(
			sessionsPath,
			JSON.stringify({claude: {session_id: 'earlier', pid: 1, started: null}}),
		);
	};

	record();
	await fixture.run({input: 'Make workspace startup faster'});
	expect(fs.existsSync(sessionsPath)).toBe(false);
	if (sqliteRun) {
		const db = new Database(path.join(stateDir, 'state.db'), {readonly: true});
		expect(db.query('SELECT * FROM agent_sessions').all()).toStrictEqual([]);
		db.close();
	}

	record();
	await fixture.run();
	expect(fs.existsSync(sessionsPath)).toBe(true);
});

// Resume mode reopens a space: if the agent has nothing to resume it starts
// idle instead of being handed the issue key.
test('resume mode launches without a prompt; agy gets its built-in prompt flag', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			agent_profiles: {argon: {command: 'agy', model: 'gemini-4-argon-medium'}},
			profiles: {other: {display_name: 'Other', agent_profile: 'argon'}},
		}),
	);
	const launchArgs = () =>
		fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');

	await fixture.run({profile: 'other'});
	let args = launchArgs();
	expect(args.includes('--no-prompt')).toBe(false);
	expect(args[args.indexOf('--agent-prompt-args') + 1]).toBe('-i {prompt}');
	expect(args[args.indexOf('--agent-launch-flags') + 1]).toBe(
		'--model gemini-4-argon-medium',
	);

	fs.mkdirSync(
		path.join(fixture.home, '.lasagna/worktrees/main checkout/test-abc'),
		{
			recursive: true,
		},
	);
	await fixture.run({open: true});
	args = launchArgs();
	expect(args.includes('--no-prompt')).toBe(true);
	expect(args.includes('--init-cmd')).toBe(false);
});

test('a bad claude config fails before the issue is created', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({claude: {extra_args: '--verbose'}}),
	);
	await rejectionOf(fixture.run({input: 'Make workspace startup faster'}));
	expect(
		fs.existsSync(
			path.join(fixture.home, '.lasagna', 'repos', 'main checkout'),
		),
	).toBe(false);
});

test('batched commands preserve order, multiline strings and command stdin', async () => {
	const fixture = setup();
	const expected = 'a\tb\nquoted "text" and \u0024(literal)\n';
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: [
				// Reading stdin must not consume the next command's config record.
				{name: 'Read stdin\n\n', run: 'cat > "${WORKTREE_PATH}/stdin"'},
				{run: `printf '%s' '${expected}' > "\${WORKTREE_PATH}/value"`},
				{run: 'false', continue_on_error: true},
				{run: 'printf done >> "${WORKTREE_PATH}/value"'},
			],
		}),
	);
	const output = await fixture.run();
	expect(output.includes('Read stdin\n'), output).toBe(true);
	expect(output.includes('Read stdin\n\n'), output).toBe(false);
	expect(
		output.includes('post_workspace_init: post_workspace_init[1] ->'),
		output,
	).toBe(true);
	expect(fs.readFileSync(path.join(fixture.workspace, 'stdin'), 'utf8')).toBe(
		'',
	);
	expect(fs.readFileSync(path.join(fixture.workspace, 'value'), 'utf8')).toBe(
		expected + 'done',
	);
});

test('an aliased post_workspace_init list still runs', async () => {
	const fixture = setup();
	const config = parse(fixture.config('Main config')) as Record<
		string,
		unknown
	>;
	delete config['post_workspace_init'];
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.yml'),
		stringify(config) +
			'common: &common\n  - run: touch "${WORKTREE_PATH}/aliased"\npost_workspace_init: *common\n',
	);
	await fixture.run();
	expect(fs.existsSync(path.join(fixture.workspace, 'aliased'))).toBe(true);
});

test('a failing required command still stops setup before Claude starts', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: [
				{run: 'false'},
				{run: 'touch "${WORKTREE_PATH}/unexpected"'},
			],
		}),
	);
	await rejectionOf(fixture.run());
	expect(fs.existsSync(fixture.launchArgs)).toBe(false);
	expect(fs.existsSync(path.join(fixture.workspace, 'unexpected'))).toBe(false);
});
