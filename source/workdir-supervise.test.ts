import {test, expect, beforeEach} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {testState} from '../test/helpers/state.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {workdirFixture} from '../test/helpers/workdir-fixture.ts';
import type {Hold} from './holds.ts';
import {resetProviders} from './providers/index.ts';
import {resetRepoContexts} from './repo-context.ts';
import {newSpaceIdentity} from './space-identity.ts';
import {setSpaceScopes} from './space-scope.ts';
import {createStateDaos, type StateDaos} from './state-daos.ts';
import {runSuperviseCommand} from './supervise-command.ts';
import {initTmuxState, type OuterTmuxRunner} from './tmux.ts';
import {spansWorkdir, workdirSuperviseDeps} from './workdir-supervise.ts';

beforeEach(() => {
	resetProviders();
	resetRepoContexts();
});

const PROFILES = 'version: 1\nprofiles:\n  t:\n    display_name: T\n';
const idleScreen = fs.readFileSync(
	path.join(
		import.meta.dirname,
		'..',
		'test',
		'fixtures',
		'agent-screens',
		'claude-idle.txt',
	),
	'utf8',
);

const hold = (id: string, key: string): Hold => ({
	id,
	key,
	tool: 'Bash command',
	command: 'git push origin main',
	filePath: null,
	cwd: null,
	approvable: true,
	reason: 'pushes to main',
	state: 'open',
	createdAt: '2026-11-26T08:00:00.000Z',
	resolvedAt: null,
});

/**
 * The supervise verbs as they run at the root of a work dir of two repos,
 * each with an agent whose session is live: API-1 in api, WEB-2 in web.
 */
async function atTheRoot() {
	const made = workdirFixture({
		repos: {api: {}, web: {}},
		workdirConfig: names =>
			`${PROFILES}repos:\n  ${names['api']}:\n    team_prefix: API\n  ${names['web']}:\n    team_prefix: WEB\n`,
	});
	const own = testState({repo: made.workRepo, mainRoot: () => made.work});
	// Back to one repo for the tests after this one.
	teardown(() => {
		setSpaceScopes(undefined);
		initTmuxState(own.daos);
	});
	const stores = new Map<string, StateDaos>();
	const deps = workdirSuperviseDeps(
		made.work,
		{repoName: made.workRepo, daos: own.daos},
		{
			setup(repo) {
				const daos = createStateDaos({
					repo: repo.name,
					stateDir: own.stateDir,
					sqlite: own.sqlite,
					mainRoot: () => repo.mainRoot,
				});
				teardown(() => daos.disconnectStatusDaemon());
				stores.set(repo.name, daos);
				return {daos};
			},
		},
	);
	const api = made.repos['api']!.name;
	const web = made.repos['web']!.name;
	const sessions: string[] = [];
	for (const [repo, key] of [
		[api, 'API-1'],
		[web, 'WEB-2'],
	] as const) {
		const identity = newSpaceIdentity({
			repo,
			key,
			worktreePath: `/worktrees/${repo}/${key}`,
			socket: 'test',
		});
		await stores.get(repo)!.registry.add(key);
		await stores.get(repo)!.spaceIdentities.record(identity);
		sessions.push(identity.tmux.agentSession);
	}

	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions')
			return {status: 0, stdout: `${sessions.join('\n')}\n`};
		if (args[0] === 'capture-pane') return {status: 0, stdout: idleScreen};
		return {status: 1, stdout: ''};
	};

	const out: string[] = [];
	const err: string[] = [];
	let clock = new Date(2026, 10, 26, 9, 0).getTime();
	const run = async (...argv: string[]) =>
		runSuperviseCommand(argv, {
			...deps,
			runner,
			now: () => new Date(clock),
			async sleep(ms) {
				clock += ms;
			},
			async waitForStatusChange(ms) {
				clock += ms;
			},
			out: text => out.push(text),
			err: text => err.push(text),
			log() {},
			caller: 'user',
		});
	return {...made, api, web, own, stores, deps, run, out, err};
}

test('only the verbs that take no space, or several, are about the whole work dir', () => {
	expect(spansWorkdir(['watch'])).toBe(true);
	expect(spansWorkdir(['watch', '--until', 'blocked'])).toBe(true);
	expect(spansWorkdir(['holds'])).toBe(true);
	expect(spansWorkdir(['holds', '--all', '--json'])).toBe(true);
	expect(spansWorkdir(['schedules'])).toBe(true);
	expect(spansWorkdir(['holds', 'approve', 'h1234567'])).toBe(false);
	expect(spansWorkdir(['holds', 'dismiss', 'h1234567'])).toBe(false);
	expect(spansWorkdir(['unschedule', 'a1b2c3d4'])).toBe(false);
	expect(spansWorkdir(['state', 'main'])).toBe(false);
	expect(spansWorkdir(['schedule', 'fire', 'a1b2c3d4'])).toBe(false);
});

test('at the root a space is named with its repo, its key read the way that repo reads keys', async () => {
	const {deps, api, web, workRepo} = await atTheRoot();
	expect(deps.resolveKey(`${api}:API-1`)).toBe(`${api}:API-1`);
	// A bare number takes the team prefix of the repo it is typed for.
	expect(deps.resolveKey(`${api}:7`)).toBe(`${api}:API-7`);
	expect(deps.resolveKey(`${web}:7`)).toBe(`${web}:WEB-7`);
	// With no repo it is one of the work dir's own.
	expect(deps.resolveKey('main')).toBe(`${workRepo}:main`);
	// A repo the work dir doesn't have names nothing: the whole text is a key
	// of the work dir's own, which has no such space.
	expect(deps.resolveKey('nope:STA-1')).toBe(`${workRepo}:nope:STA-1`);
});

test('at the root each space\u2019s hook status is read under its own repo', async () => {
	const {deps, api, web, workRepo} = await atTheRoot();
	expect(await deps.hookKey(`${api}:API-1`)).toBe(`${api}-API-1`);
	expect(await deps.hookKey(`${web}:WEB-2`)).toBe(`${web}-WEB-2`);
	expect(await deps.hookKey(`${workRepo}:main`)).toBe(`${workRepo}-main`);
});

test('at the root watch with no keys sees the agents of every repo, each by repo:KEY', async () => {
	const {run, out, err, api, web} = await atTheRoot();
	expect(
		await run('watch', '--until', 'idle', '--timeout', '1', '--json'),
	).toBe(0);
	expect(err).toEqual([]);
	const result = JSON.parse(out[0]!) as {
		result: string;
		changes: Array<{key: string; to: string}>;
	};
	expect(result.result).toBe('changed');
	expect(
		result.changes.map(change => `${change.key} ${change.to}`).sort(),
	).toEqual([`${api}:API-1 idle`, `${web}:WEB-2 idle`].sort());
});

test('watch takes spaces of two repos at once', async () => {
	const {run, out, err, api, web} = await atTheRoot();
	expect(
		await run(
			'watch',
			'--until',
			'idle',
			'--timeout',
			'1',
			'--json',
			'--',
			`${api}:1`,
			`${web}:WEB-2`,
		),
	).toBe(0);
	expect(err).toEqual([]);
	const result = JSON.parse(out[0]!) as {changes: Array<{key: string}>};
	expect(result.changes.map(change => change.key)).toEqual([
		`${api}:API-1`,
		`${web}:WEB-2`,
	]);
});

test('at the root holds and schedules list every repo\u2019s, each by repo:KEY', async () => {
	const {run, out, stores, own, api, web, workRepo} = await atTheRoot();
	await stores.get(api)!.holds.save(hold('h-api', 'API-1'));
	await stores.get(web)!.holds.save(hold('h-web', 'WEB-2'));
	await own.daos.holds.save({...hold('h-own', 'main'), state: 'dismissed'});
	await stores.get(web)!.schedules.save({
		kind: 'at',
		id: 'job-web',
		key: 'WEB-2',
		at: '2026-11-27T08:00:00.000Z',
		message: 'carry on',
		arm: 0,
	});

	expect(await run('holds', '--json')).toBe(0);
	const open = JSON.parse(out.pop()!) as Hold[];
	expect(new Set(open.map(each => `${each.id} ${each.key}`))).toEqual(
		new Set([`h-api ${api}:API-1`, `h-web ${web}:WEB-2`]),
	);
	expect(await run('holds', '--all', '--json')).toBe(0);
	expect((JSON.parse(out.pop()!) as Hold[]).map(each => each.key)).toContain(
		`${workRepo}:main`,
	);
	// One repo's, by its space's full name.
	expect(await run('holds', `${web}:2`, '--json')).toBe(0);
	expect((JSON.parse(out.pop()!) as Hold[]).map(each => each.id)).toEqual([
		'h-web',
	]);

	expect(await run('schedules')).toBe(0);
	expect(out.pop()).toBe(
		`job-web  ${web}:WEB-2  at 2026-11-27T08:00:00.000Z: carry on`,
	);
});
