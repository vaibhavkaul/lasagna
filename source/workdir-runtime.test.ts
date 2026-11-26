import {test, expect, beforeEach} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {testState} from '../test/helpers/state.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {
	git,
	listRepos,
	workdirFixture,
} from '../test/helpers/workdir-fixture.ts';
import {getTeamPrefix} from './config.ts';
import {issueTrackerFor, resetProviders} from './providers/index.ts';
import {resetRepoContexts} from './repo-context.ts';
import {
	scopedSpace,
	setSpaceScopes,
	spaceBareKey,
	spaceNameIn,
} from './space-scope.ts';
import {newSpaceIdentity} from './space-identity.ts';
import {initTmuxState, spaceSessionNames} from './tmux.ts';
import {repoTags, startWorkdir} from './workdir-runtime.ts';

beforeEach(() => {
	resetProviders();
	resetRepoContexts();
});

const PROFILES = 'version: 1\nprofiles:\n  t:\n    display_name: T\n';

/** A work dir of two repos started the way the TUI starts it. */
function started(
	workdirConfig: (names: Record<string, string>) => string = listRepos,
	prepare: (work: string) => void = () => {},
) {
	const made = workdirFixture({repos: {api: {}, web: {}}, workdirConfig});
	prepare(made.work);
	const own = testState({repo: made.workRepo, mainRoot: () => made.work});
	// Back to one repo for the tests after this one.
	teardown(() => {
		setSpaceScopes(undefined);
		initTmuxState(own.daos);
	});
	const runtime = startWorkdir(made.work, {
		repoName: made.workRepo,
		daos: own.daos,
	});
	return {...made, own, runtime};
}

test('repos get a short tag: initials for several words, first letters for one', () => {
	expect(
		Object.fromEntries(
			repoTags([
				'appian-server',
				'appian-frontend',
				'tts-business',
				'data-eng',
				'consul',
				'terraform',
			]),
		),
	).toEqual({
		'appian-server': 'as',
		'appian-frontend': 'af',
		'tts-business': 'tb',
		'data-eng': 'de',
		consul: 'co',
		terraform: 'te',
	});
});

test('two repos never share a tag', () => {
	const tags = repoTags([
		'api-server',
		'app-store',
		'auth_service',
		'a.s',
		'consul',
		'config',
		'compose',
	]);
	expect(new Set(tags.values()).size).toBe(tags.size);
	expect(tags.get('api-server')).toBe('as');
	for (const tag of tags.values()) expect(tag.length).toBeLessThanOrEqual(3);
});

test('a work dir starts with every repo it lists, after its own pseudo-repo', () => {
	const {runtime, work, workRepo, repos} = started();
	expect(runtime.root).toBe(work);
	expect(runtime.label).toBe(path.basename(work));
	expect(runtime.own.name).toBe(workRepo);
	expect(runtime.own.isWorkdir).toBe(true);
	expect(runtime.repos.map(repo => repo.name)).toEqual([
		repos['api']!.name,
		repos['web']!.name,
	]);
	expect(runtime.all.map(repo => repo.name)).toEqual([
		workRepo,
		repos['api']!.name,
		repos['web']!.name,
	]);
	expect(runtime.rootMain).toBe(`${workRepo}:main`);
	expect(runtime.repo(repos['web']!.name)?.context.mainRoot).toBe(
		repos['web']!.root,
	);
});

test('a listed directory that is no checkout, or is gone, is left off the rail', () => {
	const {runtime, repos} = started(
		names => `${listRepos(names)}  plain-directory:\n  gone:\n`,
		work => fs.mkdirSync(path.join(work, 'plain-directory')),
	);
	expect(runtime.repos.map(repo => repo.name)).toEqual([
		repos['api']!.name,
		repos['web']!.name,
	]);
});

test('a listed directory inside another checkout is not a repo of its own', () => {
	const made = workdirFixture({repos: {api: {'docs/readme.md': 'x'}}});
	fs.mkdirSync(path.join(made.work, '.lasagna'));
	fs.writeFileSync(
		path.join(made.work, '.lasagna', 'workdir.yml'),
		`${PROFILES}repos:\n  docs:\n    path: ${made.repos['api']!.name}/docs\n`,
	);
	const own = testState({repo: made.workRepo, mainRoot: () => made.work});
	teardown(() => {
		setSpaceScopes(undefined);
		initTmuxState(own.daos);
	});
	expect(
		startWorkdir(made.work, {repoName: made.workRepo, daos: own.daos}).repos,
	).toEqual([]);
});

test('a space name says which repo it is in, and what its key is there', () => {
	const {runtime, repos, workRepo} = started();
	const api = repos['api']!.name;
	const scope = scopedSpace(`${api}:STA-1`);
	expect(scope?.repo.name).toBe(api);
	expect(scope?.repo.mainRoot).toBe(repos['api']!.root);
	expect(scope?.key).toBe('STA-1');
	expect(spaceBareKey(`${api}:STA-1`)).toBe('STA-1');
	expect(scopedSpace(runtime.rootMain)?.repo.name).toBe(workRepo);
	expect(runtime.repoOf(`${api}:STA-1`)?.name).toBe(api);
	// A name that carries no repo the work dir has stays the process's own.
	expect(scopedSpace('STA-1')).toBeUndefined();
	expect(scopedSpace('nope:STA-1')).toBeUndefined();
	expect(spaceNameIn(api, 'STA-1')).toBe(`${api}:STA-1`);
});

test('each repo reads its own section of the workdir config', () => {
	const {runtime, repos} = started(
		names =>
			`${PROFILES}team_prefix: TOP\nrepos:\n  ${names['api']}:\n    team_prefix: API\n  ${names['web']}:\n`,
	);
	const prefix = (name: string) => {
		const load = runtime.repo(name)!.context.readConfig();
		return load.kind === 'valid' ? getTeamPrefix(load.config) : load.kind;
	};

	expect(prefix(repos['api']!.name)).toBe('API');
	expect(prefix(repos['web']!.name)).toBe('TOP');
	expect(prefix(runtime.own.name)).toBe('TOP');
});

test('each repo has its own tracker, and its own stores behind the shared ones', async () => {
	const {runtime, repos} = started();
	const api = runtime.repo(repos['api']!.name)!;
	const web = runtime.repo(repos['web']!.name)!;
	expect(issueTrackerFor(api.name)).not.toBe(issueTrackerFor(web.name));
	await runtime.daos.registry.add(`${web.name}:STA-1`);
	expect(web.daos.registry.has('STA-1')).toBe(true);
	expect(api.daos.registry.has('STA-1')).toBe(false);
});

test('tmux.ts finds a space\u2019s sessions through its repo\u2019s stores', async () => {
	const {runtime, repos} = started();
	const web = runtime.repo(repos['web']!.name)!;
	await web.daos.registry.add('STA-1');
	await web.daos.spaceIdentities.record(
		newSpaceIdentity({
			repo: web.name,
			key: 'STA-1',
			worktreePath: '/worktrees/STA-1',
			socket: 'test',
		}),
	);
	expect(spaceSessionNames(`${web.name}:STA-1`)).toEqual({
		agent: `agent-${web.name}-STA-1`,
		companion: `companion-${web.name}-STA-1`,
	});
});

test('a repo\u2019s linked worktree elsewhere is still that repo\u2019s, not a repo of the rail', () => {
	const {runtime, repos, work} = started();
	git(
		repos['api']!.root,
		'worktree',
		'add',
		'-q',
		'-b',
		'STA-3',
		path.join(work, 'api-STA-3'),
	);
	expect(runtime.repos.map(repo => repo.name)).toEqual([
		repos['api']!.name,
		repos['web']!.name,
	]);
});
