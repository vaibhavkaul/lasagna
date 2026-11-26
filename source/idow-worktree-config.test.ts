import {Database} from 'bun:sqlite';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {parse} from 'yaml';
import {repoNameFromGitCommonDir} from './config.ts';
import {newSpaceIdentity, protectedSessionNames} from './space-identity.ts';
import {createStateDaos} from './state-daos.ts';
import {closeStateDb, stateDbPath} from './state-db.ts';
import {sqliteRun} from '../test/helpers/state.ts';
import {
	cleanupOrphanedInnerSessions,
	initTmuxState,
	type OuterTmuxRunner,
} from './tmux.ts';
import {setup} from '../test/helpers/idow-fixture.ts';

test('idow creates and reopens real worktrees in the main repository namespace', async () => {
	const fixture = setup(true);
	fs.writeFileSync(
		path.join(fixture.linked, '.pappardelle.local.yml'),
		'claude:\n  model: linked-model\n',
	);
	const output = await fixture.run();
	expect(output.includes(`Worktree:  ${fixture.workspace}`), output).toBe(true);
	expect(fs.existsSync(path.join(fixture.workspace, '.git'))).toBe(true);
	const args = fs.readFileSync(fixture.launchArgs, 'utf8');
	expect(args.includes(`--repo-name\n${path.basename(fixture.main)}\n`)).toBe(
		true,
	);
	expect(args.includes('--agent-launch-flags\n--model linked-model\n')).toBe(
		true,
	);
	expect(
		fs.existsSync(
			path.join(
				fixture.home,
				'.lasagna',
				'repos',
				path.basename(fixture.main),
				'space-state',
				'test-abc.json',
			),
		),
	).toBe(true);
	const reopened = await fixture.run();
	expect(
		reopened.includes(`Worktree exists: ${fixture.workspace}`),
		reopened,
	).toBe(true);
	expect(reopened.includes('Created worktree:')).toBe(false);
});

test("a new worktree links the main checkout's CLAUDE.local.md", async () => {
	const fixture = setup(true);
	const notes = path.join(fixture.main, 'CLAUDE.local.md');
	fs.writeFileSync(notes, '# notes\n');
	await fixture.run();
	expect(fs.readlinkSync(path.join(fixture.workspace, 'CLAUDE.local.md'))).toBe(
		notes,
	);
	const status = execFileSync(
		'git',
		['-C', fixture.workspace, 'status', '--porcelain'],
		{encoding: 'utf8'},
	);
	expect(status.includes('CLAUDE.local.md'), status).toBe(false);
});

test('idow creates a session using main config and worktree-local overrides', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.linked, '.pappardelle.local.yml'),
		'claude:\n  model: linked-model\n',
	);
	const output = await fixture.run();
	expect(fs.existsSync(fixture.vcsCalls)).toBe(false);
	expect(output.includes('Workspace test-abc is ready!'), output).toBe(true);
	expect(output.includes('Profile:   Main config'), output).toBe(true);
	expect(
		fs
			.readFileSync(fixture.launchArgs, 'utf8')
			.includes('--agent-launch-flags\n--model linked-model\n'),
	).toBe(true);
	expect(
		fs.readFileSync(
			path.join(fixture.workspace, '.pappardelle.local.yml'),
			'utf8',
		),
	).toBe('claude:\n  model: linked-model\n');
	for (const file of ['.env', 'profile.env']) {
		expect(fs.readFileSync(path.join(fixture.workspace, file), 'utf8')).toBe(
			'FROM_MAIN=1\n',
		);
	}
});

test('idow opens from a linked checkout and expands both repository roots', async () => {
	const fixture = setup();
	const output = await fixture.run({open: true, projectRoot: false});
	expect(fs.readFileSync(fixture.vcsCalls, 'utf8').includes('pr view')).toBe(
		true,
	);
	expect(output.includes('https://github.com/test/repo/pull/1')).toBe(true);
	expect(output.includes('Workspace test-abc is ready!'), output).toBe(true);
	expect(
		fs
			.readFileSync(fixture.launchArgs, 'utf8')
			.includes('--agent-launch-flags\n--model main-model\n'),
	).toBe(true);
	expect(fs.readFileSync(path.join(fixture.workspace, 'roots'), 'utf8')).toBe(
		`${fixture.main}\n${fixture.linked}\n`,
	);
});

test('idow names a space the same from a linked worktree as from the main checkout', async () => {
	const named = [];
	for (const from of ['main', 'linked'] as const) {
		const fixture = setup();
		await fixture.run({projectRoot: false, cwd: fixture[from]});
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		const after = (flag: string) => args[args.indexOf(flag) + 1];
		named.push({
			repo: after('--repo-name'),
			agent: after('--agent-session'),
			companion: after('--companion-session'),
		});
		if (sqliteRun) {
			const db = new Database(path.join(fixture.home, '.lasagna', 'state.db'), {
				readonly: true,
			});
			teardown(() => {
				db.close();
			});
			expect(
				db
					.query(
						'SELECT repo, key, agent_session, companion_session FROM space_identities ORDER BY key',
					)
					.all(),
			).toStrictEqual([
				{
					repo: 'main checkout',
					key: 'main',
					agent_session: 'agent-main checkout-main',
					companion_session: 'companion-main checkout-main',
				},
				{
					repo: 'main checkout',
					key: 'test-abc',
					agent_session: 'agent-main checkout-test-abc',
					companion_session: 'companion-main checkout-test-abc',
				},
			]);
		}
	}

	expect(named).toStrictEqual([
		{
			repo: 'main checkout',
			agent: 'agent-main checkout-test-abc',
			companion: 'companion-main checkout-test-abc',
		},
		{
			repo: 'main checkout',
			agent: 'agent-main checkout-test-abc',
			companion: 'companion-main checkout-test-abc',
		},
	]);
});

if (sqliteRun) {
	test('a space idow opened from a linked worktree survives the reap of a TUI started from another', async () => {
		const fixture = setup();
		await fixture.run({
			projectRoot: false,
			cwd: fixture.linked,
			extraEnv: {LASAGNA_REGISTER_SPACE: '1'},
		});
		const other = path.join(path.dirname(fixture.main), 'other linked');
		execFileSync('git', [
			'-C',
			fixture.main,
			'worktree',
			'add',
			'-b',
			'other',
			other,
		]);
		const repo = repoNameFromGitCommonDir(
			execFileSync(
				'git',
				['rev-parse', '--path-format=absolute', '--git-common-dir'],
				{cwd: other, encoding: 'utf8'},
			).trim(),
		);
		const stateDir = path.join(fixture.home, '.lasagna');
		const daos = createStateDaos({
			repo,
			stateDir,
			sqlite: true,
			home: fixture.home,
			mainRoot: () => fixture.main,
		});
		teardown(() => {
			daos.disconnectStatusDaemon();
			closeStateDb(stateDbPath(stateDir));
		});
		initTmuxState(daos);
		const owned = protectedSessionNames(daos.registry, daos.spaceIdentities);
		if (owned.kind !== 'names') {
			expect.unreachable(`the reap would be skipped: ${JSON.stringify(owned)}`);
			return;
		}

		const live = [
			'agent-main checkout-test-abc',
			'companion-main checkout-test-abc',
			'agent-main checkout-main',
			'agent-main checkout-gone-1',
		];
		const killed: string[] = [];
		const runner: OuterTmuxRunner = args => {
			if (args[0] === 'kill-session') killed.push(args[2]!);
			return {
				status: 0,
				stdout: args[0] === 'list-sessions' ? live.join('\n') : '',
			};
		};
		expect(cleanupOrphanedInnerSessions(owned, repo, runner, [repo])).toBe(1);
		expect(killed).toStrictEqual(['=agent-main checkout-gone-1:']);
	});
}

if (sqliteRun) {
	test('idow opens a space in the worktree the stores name', async () => {
		const fixture = setup();
		const stateDir = path.join(fixture.home, '.lasagna');
		const daos = createStateDaos({
			repo: path.basename(fixture.main),
			stateDir,
			sqlite: true,
			home: fixture.home,
			mainRoot: () => fixture.main,
		});
		teardown(() => {
			daos.disconnectStatusDaemon();
			closeStateDb(stateDbPath(stateDir));
		});
		const stored = path.join(fixture.home, 'elsewhere', 'login');
		await daos.spaceIdentities.record(
			newSpaceIdentity({
				repo: path.basename(fixture.main),
				key: 'test-abc',
				worktreePath: stored,
				socket: 'lasagna_inner',
			}),
		);
		await fixture.run();
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		expect(args[args.indexOf('--worktree') + 1]).toBe(stored);
		expect(fs.existsSync(stored)).toBe(true);
	});
}
