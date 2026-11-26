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
	setTicketMembers,
	spaceBareKey,
	spaceNameIn,
	ticketMembers,
} from './space-scope.ts';
import {newSpaceIdentity} from './space-identity.ts';
import {
	createCompanionSplit,
	initTmuxState,
	spaceSessionNames,
	spaceSimulatorCleanup,
} from './tmux.ts';
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
		setTicketMembers(undefined);
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
		setTicketMembers(undefined);
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

test('a companion split of a repo\u2019s space is told that repo\u2019s main checkout, not the work dir', () => {
	const {runtime, repos, work} = started();
	const web = runtime.repo(repos['web']!.name)!;
	const calls: string[][] = [];
	const result = createCompanionSplit(
		newSpaceIdentity({
			repo: web.name,
			key: 'STA-1',
			worktreePath: '/worktrees/STA-1',
			socket: 'test',
		}),
		{name: 'logs', command: 'tail -f log', split: 'down'},
		{
			runner(args) {
				calls.push([...args]);
				return {status: 0, stdout: '/worktrees/STA-1\n'};
			},
		},
	);
	expect(result.ok).toBe(true);
	const created = calls.find(args => args[0] === 'new-session')!;
	const environment = created.filter((_, index) => created[index - 1] === '-e');
	expect(environment).toEqual([
		`LASAGNA_REPO=${web.name}`,
		'LASAGNA_SPACE=STA-1',
		`LASAGNA_MAIN_REPO_ROOT=${repos['web']!.root}`,
	]);
	expect(environment).not.toContain(`LASAGNA_MAIN_REPO_ROOT=${work}`);
});

test('closing a repo\u2019s space deletes the simulator named after its key, unless another repo has that key open', async () => {
	const {runtime, repos} = started();
	const api = repos['api']!.name;
	const web = repos['web']!.name;
	const deleted: string[] = [];
	const cleanup = spaceSimulatorCleanup(async args => {
		if (args[0] === 'delete') deleted.push(args[1]!);
		return args[0] === 'list'
			? JSON.stringify({
					devices: {
						runtime: [
							{name: 'QA-STA-1', udid: 'id-1'},
							{name: 'QA-STA-2', udid: 'id-2'},
						],
					},
				})
			: '';
	});
	// STA-1 was only api's. STA-2 is still open in web.
	await runtime.daos.registry.add(`${web}:STA-2`);
	expect(await cleanup.delete(`${api}:STA-1`)).toBe(true);
	expect(await cleanup.delete(`${api}:STA-2`)).toBe(true);
	expect(deleted).toEqual(['id-1']);
	// Once web closes it too, the simulator goes.
	await runtime.daos.registry.remove(`${web}:STA-2`);
	expect(await cleanup.delete(`${web}:STA-2`)).toBe(true);
	expect(deleted).toEqual(['id-1', 'id-2']);
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

test('a space of the work dir that has a ticket folder is a ticket space, and says which repos it holds', () => {
	const {runtime, repos, workRepo} = started();
	const api = runtime.repo(repos['api']!.name)!;
	const web = runtime.repo(repos['web']!.name)!;
	runtime.tickets.write({
		key: 'B2B-5',
		folder: '/tickets/B2B-5',
		repos: [
			{name: web.name, worktreePath: `/tickets/B2B-5/${web.name}`},
			{name: api.name, worktreePath: `/tickets/B2B-5/${api.name}`},
			// A repo the work dir no longer lists has nothing to answer for it.
			{name: 'gone', worktreePath: '/tickets/B2B-5/gone'},
		],
	});
	teardown(() => runtime.tickets.remove('B2B-5'));

	const members = [
		{repo: web.context, worktreePath: `/tickets/B2B-5/${web.name}`},
		{repo: api.context, worktreePath: `/tickets/B2B-5/${api.name}`},
	];
	expect(runtime.ticketMembers(`${workRepo}:B2B-5`)).toEqual(members);
	// Everything handed a space name can ask.
	expect(ticketMembers(`${workRepo}:B2B-5`)).toEqual(members);
	// Its own repo is still the work dir: that is whose agent and config it has.
	expect(scopedSpace(`${workRepo}:B2B-5`)?.repo.name).toBe(workRepo);

	// The work dir's main space, a space no folder was made for, and a repo's
	// own space with the same key are none.
	expect(ticketMembers(runtime.rootMain)).toBeUndefined();
	expect(ticketMembers(`${workRepo}:NOPE-1`)).toBeUndefined();
	expect(ticketMembers(`${api.name}:B2B-5`)).toBeUndefined();
});
