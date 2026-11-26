import {Database} from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {stringify} from 'yaml';
import {sqliteRun} from '../test/helpers/state.ts';
import {setup, writeScript} from '../test/helpers/idow-fixture.ts';

const escapeRegExp = (text: string) =>
	text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stateCli(fixture: ReturnType<typeof setup>, exitCode: number) {
	const calls = path.join(fixture.home, 'state-cli-calls');
	const executable = path.join(fixture.bin, 'pappardelle-state-stub');
	writeScript(
		executable,
		`if [[ "$2" != space && "$2" != worktree-path && "$2" != check-config ]]; then
    test ! -f "$IDOW_TEST_LAUNCH_ARGS" || echo "after sessions" >> ${JSON.stringify(calls)}
    printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
fi
${exitCode === 0 ? '' : `if [[ "$2" != space && "$2" != worktree-path && "$2" != check-config ]]; then\n    echo "no state for you" >&2\n    exit ${exitCode}\nfi\n`}exec ${JSON.stringify(path.join(fixture.bin, 'pappardelle-state'))} "$@"`,
	);
	return {
		calls: () => fs.readFileSync(calls, 'utf8').trim().split('\n'),
		env: {
			PAPPARDELLE_EXECUTABLE: executable,
			PAPPARDELLE_REGISTER_SPACE: '1',
		},
	};
}

test('idow started by Pappardelle records the space under its own pid before starting sessions', async () => {
	const fixture = setup();
	const state = stateCli(fixture, 0);
	await fixture.run({extraEnv: state.env});
	const [call, ...rest] = state.calls();
	// The agent's hook records its session id under this agent profile.
	expect(rest).toStrictEqual([
		`--internal-state launch-agent --repo ${path.basename(fixture.main)} --agent-profile claude --claude test-abc`,
	]);
	expect(call!).toMatch(
		new RegExp(
			`^--internal-state prepare-space --repo ${path.basename(fixture.main)} --title=Test issue --worktree ${escapeRegExp(fixture.workspace)} --main-root ${escapeRegExp(fixture.main)} --register --owner \\d+ --profile dev test-abc$`,
		),
	);
	expect(fs.existsSync(fixture.launchArgs)).toBe(true);
});

test('idow stops before starting sessions when the space cannot be recorded', async () => {
	const fixture = setup();
	const state = stateCli(fixture, 1);
	const error = await rejectionOf(fixture.run({extraEnv: state.env}));
	expect(String(error?.message)).toMatch(/Could not record workspace test-abc/);
	expect(fs.existsSync(fixture.launchArgs)).toBe(false);
});

test('idow run by hand saves the profile of a new workspace without registering the space, and only the title on a reopen', async () => {
	const fixture = setup();
	const state = stateCli(fixture, 0);
	const extraEnv = {
		PAPPARDELLE_EXECUTABLE: state.env.PAPPARDELLE_EXECUTABLE,
	};
	const repo = path.basename(fixture.main);
	await fixture.run({extraEnv});
	expect(state.calls()).toStrictEqual([
		`--internal-state prepare-space --repo ${repo} --title=Test issue --worktree ${fixture.workspace} --main-root ${fixture.main} --profile dev test-abc`,
		`--internal-state launch-agent --repo ${repo} --agent-profile claude --claude test-abc`,
	]);
	expect(fs.existsSync(fixture.launchArgs)).toBe(true);

	await fixture.run({extraEnv});
	expect(state.calls().at(-3)).toBe(
		`--internal-state prepare-space --repo ${repo} --title=Test issue --worktree ${fixture.workspace} --main-root ${fixture.main} test-abc`,
	);
});

// A run by hand records no registration, but its sessions are still named
// and found through the stores. scripts/state-cli.sh fails this way when it
// finds no binary and no Bun.
test('idow run by hand stops before starting sessions when the space cannot be recorded', async () => {
	const fixture = setup();
	const state = stateCli(fixture, 127);
	const error = await rejectionOf(
		fixture.run({
			input: 'Make workspace startup faster',
			extraEnv: {PAPPARDELLE_EXECUTABLE: state.env.PAPPARDELLE_EXECUTABLE},
		}),
	);
	expect(String(error?.message)).toMatch(
		/Could not record workspace test-abc: no state for you/,
	);
	expect(fs.existsSync(fixture.launchArgs)).toBe(false);
});

// idow used to write both files itself. They now come from the same writer
// as the TUI's, in whichever mode the run is in.
test('a new issue is recorded as created by Pappardelle, with its profile, before post_workspace_init', async () => {
	const fixture = setup();
	const stateDir = path.join(fixture.home, '.pappardelle');
	const repoState = path.join(stateDir, 'repos/main checkout');
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: [
				{
					run: `cp ${JSON.stringify(path.join(repoState, 'issue-meta/test-abc.json'))} "$WORKTREE_PATH/meta-during-init.json"`,
				},
			],
		}),
	);
	const before = Date.now();
	await fixture.run({input: 'Make workspace startup faster'});

	const meta = JSON.parse(
		fs.readFileSync(
			path.join(fixture.workspace, 'meta-during-init.json'),
			'utf8',
		),
	) as {created_by_pappardelle: boolean; created_at: string};
	expect(Object.keys(meta)).toStrictEqual([
		'created_by_pappardelle',
		'created_at',
	]);
	expect(meta.created_by_pappardelle).toBe(true);
	expect(meta.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
	expect(Date.parse(meta.created_at) >= before - 1000).toBe(true);
	const state = JSON.parse(
		fs.readFileSync(path.join(repoState, 'space-state/test-abc.json'), 'utf8'),
	) as {profile: string; updatedAt: string};
	expect(state.profile).toBe('dev');
	expect(Date.parse(state.updatedAt) >= before).toBe(true);

	const dbPath = path.join(stateDir, 'state.db');
	if (!sqliteRun) {
		expect(fs.existsSync(dbPath)).toBe(false);
		return;
	}

	const db = new Database(dbPath, {readonly: true});
	teardown(() => {
		db.close();
	});
	expect(
		db
			.query(
				`SELECT s.repo, s.key, s.profile, m.created_by_pappardelle, m.created_at
				FROM space_state s JOIN issue_meta m USING (repo, key)`,
			)
			.all(),
	).toStrictEqual([
		{
			repo: 'main checkout',
			key: 'test-abc',
			profile: 'dev',
			created_by_pappardelle: 1,
			created_at: meta.created_at,
		},
	]);
});

test('an existing issue is not recorded as created by Pappardelle', async () => {
	const fixture = setup();
	await fixture.run();
	expect(
		fs.existsSync(
			path.join(fixture.home, '.pappardelle/repos/main checkout/issue-meta'),
		),
	).toBe(false);
});
