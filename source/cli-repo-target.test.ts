import {test, expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {testState} from '../test/helpers/state.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	git,
	listRepos,
	workdirFixture,
	type WorkdirFixture,
} from '../test/helpers/workdir-fixture.ts';
import {
	defaultRetargetDeps,
	repoHasSpace,
	retargetCli,
	spaceKeyArgs,
	type RetargetResult,
} from './cli-repo-target.ts';
import {repoContext, resetRepoContexts} from './repo-context.ts';
import {bunIsolationArgs} from './runtime.ts';
import {createStateDaos} from './state-daos.ts';

const PROFILES = 'profiles:\n  t:\n    display_name: T\n';

const keysOf = (...argv: string[]) => spaceKeyArgs(argv).map(key => key.value);

test('each verb names its space where its own parser reads it', () => {
	expect(keysOf('send', 'api:STA-1', 'hello', 'web:STA-2')).toEqual([
		'api:STA-1',
	]);
	expect(keysOf('close', '--yes', 'api:STA-1')).toEqual(['api:STA-1']);
	expect(keysOf('read', '--turns', '3', 'api:STA-1')).toEqual(['api:STA-1']);
	expect(keysOf('highlight', 'api:STA-1', '--focus')).toEqual(['api:STA-1']);
	expect(keysOf('space', 'get', '--field', 'phase', 'api:STA-1')).toEqual([
		'api:STA-1',
	]);
	expect(keysOf('screen', 'api:STA-1', '--lines', '40')).toEqual(['api:STA-1']);
	expect(keysOf('answer', 'api:STA-1', '--option', '1')).toEqual(['api:STA-1']);
	expect(keysOf('watch', 'api:STA-1', 'api:STA-2', '--until', 'idle')).toEqual([
		'api:STA-1',
		'api:STA-2',
	]);
	expect(keysOf('companion', 'run', '--space', 'api:STA-1', 'ls')).toEqual([
		'api:STA-1',
	]);
	expect(keysOf('companion', 'run', '--space=api:STA-1', 'ls')).toEqual([
		'api:STA-1',
	]);
	expect(keysOf('--profile', 'p', 'api:STA-1')).toEqual(['api:STA-1']);
});

test('arguments that are not a space are left alone', () => {
	expect(keysOf('space', 'list')).toEqual([]);
	expect(keysOf('space', 'get', '--json')).toEqual([]);
	expect(keysOf('spaces', '--json')).toEqual([]);
	expect(keysOf('holds', 'approve', 'hold-1')).toEqual([]);
	expect(keysOf('unschedule', 'job-1')).toEqual([]);
	expect(keysOf('link-pr', 'https://github.com/o/r/pull/1')).toEqual([]);
	// A prompt is free text, and so is a lone key with no repo.
	expect(keysOf('fix', 'api:STA-1', 'please')).toEqual([]);
	expect(keysOf('STA-1')).toEqual([]);
	expect(keysOf()).toEqual([]);
});

type Fixture = WorkdirFixture & {
	api: string;
	web: string;
	run: (
		cwd: string,
		argv: string[],
		open?: Record<string, string[]>,
		env?: NodeJS.ProcessEnv,
	) => RetargetResult;
};

function fixture(): Fixture {
	teardown(resetRepoContexts);
	const made = workdirFixture({
		repos: {
			api: {'.pappardelle.yml': `version: 1\n${PROFILES}`},
			web: {'.pappardelle.yml': `version: 1\n${PROFILES}`},
		},
		workdirConfig: listRepos,
	});
	const api = made.repos['api']!.name;
	const web = made.repos['web']!.name;
	return {
		...made,
		api,
		web,
		run: (cwd, argv, open = {}, env = {}) =>
			retargetCli(argv, {
				...defaultRetargetDeps(),
				cwd,
				env,
				hasSpace: (repo, typed) => open[repo.name]?.includes(typed) ?? false,
			}),
	};
}

test('a command outside every work dir is left as it is', () => {
	const outside = tempDir('lasagna-outside-');
	git(outside, 'init', '-q');
	const result = retargetCli(['send', 'STA-1', 'hi'], {
		...defaultRetargetDeps(),
		cwd: outside,
		env: {},
		hasSpace() {
			throw new Error('nothing to look up outside a work dir');
		},
	});
	expect(result).toEqual({kind: 'unchanged'});
});

test('repo:KEY outside a work dir says there is no work dir', () => {
	const outside = tempDir('lasagna-outside-');
	git(outside, 'init', '-q');
	const result = retargetCli(['send', 'api:STA-1', 'hi'], {
		...defaultRetargetDeps(),
		cwd: outside,
		env: {},
	});
	expect(result.kind).toBe('error');
	if (result.kind === 'error') expect(result.message).toContain('work dir');
});

test('a bare key the command\u2019s own repo has stays there, untouched', () => {
	const {repos, run, api, web} = fixture();
	expect(
		run(repos['api']!.root, ['send', 'STA-1', 'hi'], {
			[api]: ['STA-1'],
			[web]: ['STA-1'],
		}),
	).toEqual({kind: 'unchanged'});
});

test('repo:KEY points the command at that repo and leaves the bare key', () => {
	const {repos, run, web} = fixture();
	const result = run(repos['api']!.root, ['send', `${web}:STA-1`, 'hi']);
	expect(result).toEqual({
		kind: 'retargeted',
		repo: {root: repos['web']!.root, mainRoot: repos['web']!.root, name: web},
		argv: ['send', 'STA-1', 'hi'],
	});
});

test('repo:KEY naming the command\u2019s own repo only drops the repo', () => {
	const {repos, run, api} = fixture();
	expect(run(repos['api']!.root, ['close', `${api}:STA-1`, '--yes'])).toEqual({
		kind: 'retargeted',
		argv: ['close', 'STA-1', '--yes'],
	});
});

test('a bare key only another repo has goes to that repo', () => {
	const {repos, run, web} = fixture();
	const result = run(repos['api']!.root, ['screen', 'WEB-4'], {
		[web]: ['WEB-4'],
	});
	expect(result.kind).toBe('retargeted');
	if (result.kind === 'retargeted') {
		expect(result.repo?.name).toBe(web);
		expect(result.argv).toEqual(['screen', 'WEB-4']);
	}
});

test('at the work dir\u2019s root a command is about the work dir itself', () => {
	const {work, workRepo, run} = fixture();
	expect(run(work, ['spaces'])).toEqual({
		kind: 'retargeted',
		repo: {root: work, mainRoot: work, name: workRepo},
		argv: ['spaces'],
	});
	// So is one in a plain directory below it.
	expect(run(path.join(work, '.lasagna'), ['space', 'list']).kind).toBe(
		'retargeted',
	);
});

test('at the work dir\u2019s root a bare key finds the one repo that has it', () => {
	const {work, repos, run, api} = fixture();
	const result = run(work, ['state', 'API-7'], {[api]: ['API-7']});
	expect(result).toEqual({
		kind: 'retargeted',
		repo: {root: repos['api']!.root, mainRoot: repos['api']!.root, name: api},
		argv: ['state', 'API-7'],
	});
});

test('a bare key in two repos is refused with both spelled out', () => {
	const {work, run, api, web} = fixture();
	const result = run(work, ['state', 'B2B-1'], {
		[api]: ['B2B-1'],
		[web]: ['B2B-1'],
	});
	expect(result).toEqual({
		kind: 'error',
		message: `B2B-1 is a space in more than one repo. Name one: ${api}:B2B-1, ${web}:B2B-1`,
	});
});

test('at the work dir\u2019s root a bare key nothing has is refused', () => {
	const {work, run} = fixture();
	const result = run(work, ['state', 'NOPE-1']);
	expect(result.kind).toBe('error');
	if (result.kind === 'error') expect(result.message).toContain('NOPE-1');
});

test('the work dir\u2019s own main space is named with its pseudo-repo', () => {
	const {work, workRepo, repos, run} = fixture();
	const result = run(repos['api']!.root, ['send', `${workRepo}:main`, 'hi']);
	expect(result).toEqual({
		kind: 'retargeted',
		repo: {root: work, mainRoot: work, name: workRepo},
		argv: ['send', 'main', 'hi'],
	});
});

test('a repo the work dir does not list is refused by name', () => {
	const {repos, run} = fixture();
	const result = run(repos['api']!.root, ['send', 'nope:STA-1', 'hi']);
	expect(result.kind).toBe('error');
	if (result.kind === 'error')
		expect(result.message).toContain('No repo nope in this work dir');
});

test('one command does not span two repos', () => {
	const {repos, run, api, web} = fixture();
	const result = run(repos['api']!.root, [
		'watch',
		`${api}:STA-1`,
		`${web}:STA-2`,
	]);
	expect(result.kind).toBe('error');
	if (result.kind === 'error')
		expect(result.message).toContain("one repo's spaces");
});

test('a companion verb\u2019s --space takes repo:KEY in both spellings', () => {
	const {repos, run, web} = fixture();
	const spaced = run(repos['api']!.root, [
		'companion',
		'run',
		'--space',
		`${web}:STA-1`,
		'ls',
	]);
	const joined = run(repos['api']!.root, [
		'companion',
		'run',
		`--space=${web}:STA-1`,
		'ls',
	]);
	expect(spaced.kind === 'retargeted' && spaced.argv).toEqual([
		'companion',
		'run',
		'--space',
		'STA-1',
		'ls',
	]);
	expect(joined.kind === 'retargeted' && joined.argv).toEqual([
		'companion',
		'run',
		'--space=STA-1',
		'ls',
	]);
});

test('a session in a worktree outside the work dir finds it through its main checkout', () => {
	const {repos, run, web} = fixture();
	const worktree = path.join(tempDir('lasagna-worktrees-'), 'STA-3');
	git(repos['api']!.root, 'worktree', 'add', '-q', '-b', 'STA-3', worktree);
	const result = run(
		worktree,
		['screen', 'WEB-4'],
		{[web]: ['WEB-4']},
		{LASAGNA_MAIN_REPO_ROOT: repos['api']!.root},
	);
	expect(result.kind === 'retargeted' && result.repo?.name).toBe(web);
});

test('a repo has a space it has open, its main space, and no other', async () => {
	const {repos, api} = fixture();
	const repo = repoContext(repos['api']!.root);
	const daos = createStateDaos({repo: api, mainRoot: () => repo.mainRoot});
	teardown(() => daos.disconnectStatusDaemon());
	await daos.registry.add('STA-12');
	expect(repoHasSpace(repo, 'STA-12')).toBe(true);
	// Typed as a bare number, it takes the repo's team prefix first.
	expect(repoHasSpace(repo, '12')).toBe(true);
	expect(repoHasSpace(repo, 'main')).toBe(true);
	expect(repoHasSpace(repo, 'STA-13')).toBe(false);
});

/** Run this checkout's CLI in `cwd`, with a HOME of the test's own. */
function runCli(
	cwd: string,
	home: string,
	args: string[],
): {code: number | null; stdout: string; stderr: string} {
	const result = spawnSync(
		process.execPath,
		[...bunIsolationArgs, path.join(import.meta.dirname, 'cli.tsx'), ...args],
		{cwd, encoding: 'utf8', env: {...process.env, HOME: home}},
	);
	return {
		code: result.status,
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
	};
}

test('the CLI answers for a space named with its repo, from another repo and from the work dir’s root', async () => {
	const {work, workRepo, repos, api, web} = fixture();
	const home = tempDir('lasagna-cli-home-');
	const stateDir = path.join(home, '.lasagna');
	const webState = testState({
		repo: web,
		stateDir,
		mainRoot: () => repos['web']!.root,
	});
	await webState.daos.registry.add('WEB-4');
	await webState.daos.spaceState.write('WEB-4', {issueTitle: 'Only in web'});
	const field = (cwd: string, key: string, name: string) =>
		runCli(cwd, home, ['space', 'get', key, '--field', name]);

	// Named with its repo, from a checkout of another repo.
	expect(field(repos['api']!.root, `${web}:WEB-4`, 'repo')).toEqual({
		code: 0,
		stdout: web,
		stderr: '',
	});
	expect(field(repos['api']!.root, `${web}:WEB-4`, 'title').stdout).toBe(
		'Only in web',
	);
	// A bare key that only one repo has is that repo's.
	expect(field(repos['api']!.root, 'WEB-4', 'repo').stdout).toBe(web);
	// From the work dir's root, which is in no checkout.
	expect(field(work, `${web}:WEB-4`, 'repo').stdout).toBe(web);
	expect(field(work, 'WEB-4', 'repo').stdout).toBe(web);
	// Each repo's own main space, and the work dir's.
	expect(field(work, `${api}:main`, 'repo').stdout).toBe(api);
	expect(field(work, `${workRepo}:main`, 'repo').stdout).toBe(workRepo);
	expect(field(work, 'main', 'repo').stdout).toBe(workRepo);

	const unknown = field(repos['api']!.root, 'nope:WEB-4', 'repo');
	expect(unknown.code).toBe(2);
	expect(unknown.stderr).toContain('No repo nope in this work dir');
}, 60_000);

test('a command run from a directory that is gone still reaches its own error', () => {
	const gone = path.join(tempDir('lasagna-gone-'), 'removed-worktree');
	fs.mkdirSync(gone);
	const result = spawnSync(
		'/bin/sh',
		[
			'-c',
			'cd "$1" && rmdir "$1" && shift && exec "$@"',
			'sh',
			gone,
			process.execPath,
			...bunIsolationArgs,
			path.join(import.meta.dirname, 'cli.tsx'),
			'spaces',
		],
		{encoding: 'utf8', env: {...process.env, HOME: tempDir('lasagna-home-')}},
	);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain(
		'lasagna must be run from within a git repository',
	);
}, 60_000);

test('the CLI refuses a bare key that two repos have, naming both', async () => {
	const {work, repos, api, web} = fixture();
	const home = tempDir('lasagna-cli-home-');
	const stateDir = path.join(home, '.lasagna');
	// One state directory serves both repos, as one HOME does.
	const apiState = testState({
		repo: api,
		stateDir,
		mainRoot: () => repos['api']!.root,
	});
	const webDaos = createStateDaos({
		repo: web,
		stateDir,
		sqlite: apiState.sqlite,
		mainRoot: () => repos['web']!.root,
	});
	teardown(() => webDaos.disconnectStatusDaemon());
	await apiState.daos.registry.add('B2B-1');
	await webDaos.registry.add('B2B-1');

	const result = runCli(work, home, [
		'space',
		'get',
		'B2B-1',
		'--field',
		'repo',
	]);
	expect(result.code).toBe(2);
	expect(result.stderr).toBe(
		`B2B-1 is a space in more than one repo. Name one: ${api}:B2B-1, ${web}:B2B-1`,
	);
	// From inside one of them the bare key is that repo's, as it always was.
	expect(
		runCli(repos['api']!.root, home, [
			'space',
			'get',
			'B2B-1',
			'--field',
			'repo',
		]).stdout,
	).toBe(api);
}, 60_000);
