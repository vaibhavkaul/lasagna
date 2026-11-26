import {test, expect} from 'bun:test';
import path from 'node:path';
import {testState, type TestState} from '../test/helpers/state.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import type {HighlightRequest} from './highlight.ts';
import type {Hold} from './holds.ts';
import type {Job} from './schedule.ts';
import {protectedSessionNames} from './space-identity.ts';
import {createStateDaos, type StateDaos} from './state-daos.ts';
import {workdirStateDaos} from './workdir-daos.ts';

type Fixture = {
	own: TestState;
	api: StateDaos;
	web: StateDaos;
	all: StateDaos;
};

/** The stores of a work dir `@work` over two repos, in one state directory. */
function fixture(): Fixture {
	const root = tempDir('lasagna-workdir-daos-');
	const own = testState({repo: '@work', mainRoot: () => root});
	const repo = (name: string) => {
		const daos = createStateDaos({
			repo: name,
			stateDir: own.stateDir,
			sqlite: own.sqlite,
			mainRoot: () => path.join(root, name),
		});
		teardown(() => daos.disconnectStatusDaemon());
		return daos;
	};

	const api = repo('api');
	const web = repo('web');
	return {
		own,
		api,
		web,
		all: workdirStateDaos({repo: '@work', daos: own.daos}, [
			{repo: 'api', daos: api},
			{repo: 'web', daos: web},
		]),
	};
}

test('a space is added to the registry of the repo its name carries, under its own key', async () => {
	const {all, api, web} = fixture();
	await all.registry.add('api:STA-1');
	await all.registry.add('web:STA-1');
	await all.registry.add('web:WEB-2');
	expect(api.registry.openSpaces()).toEqual(['STA-1']);
	expect(new Set(web.registry.openSpaces())).toEqual(
		new Set(['STA-1', 'WEB-2']),
	);
	expect(all.registry.has('api:STA-1')).toBe(true);
	expect(all.registry.has('api:WEB-2')).toBe(false);
});

test('the open spaces of every repo are listed by repo:KEY', async () => {
	const {all} = fixture();
	expect(all.registry.openSpaces()).toBeNull();
	await all.registry.add('api:STA-1');
	await all.registry.add('web:STA-1');
	expect(new Set(all.registry.openSpaces())).toEqual(
		new Set(['api:STA-1', 'web:STA-1']),
	);
	expect(new Set(await all.registry.openSpacesAsync())).toEqual(
		new Set(['api:STA-1', 'web:STA-1']),
	);
	await all.registry.remove('api:STA-1');
	expect(all.registry.openSpaces()).toEqual(['web:STA-1']);
});

test('a name that carries no repo is one of the work dir’s own', async () => {
	const {all, own, api} = fixture();
	await all.registry.add('B2B-9');
	expect(own.daos.registry.openSpaces()).toEqual(['B2B-9']);
	expect(api.registry.openSpaces()).toBeNull();
	expect(all.registry.openSpaces()).toEqual(['@work:B2B-9']);
});

test('settling asks each repo about its own keys, in the names the caller knows', async () => {
	const {all} = fixture();
	await all.registry.add('api:STA-1');
	const asked: string[] = [];
	await all.registry.settle({
		closing: {
			has(name) {
				asked.push(name);
				return false;
			},
		},
		liveSessions: () => new Set(),
	});
	// Only a registry that records closes has a close to ask about.
	for (const name of asked) expect(name).toContain(':');
	expect(all.registry.has('api:STA-1')).toBe(true);
});

test('an identity comes from the space’s repo, with that repo’s session names', () => {
	const {all} = fixture();
	const api = all.spaceIdentities.get('api:STA-1');
	const web = all.spaceIdentities.get('web:STA-1');
	if (api.kind === 'identity' && web.kind === 'identity') {
		expect(api.identity.repo).toBe('api');
		expect(api.identity.key).toBe('STA-1');
		expect(api.identity.tmux.agentSession).toBe('agent-api-STA-1');
		expect(web.identity.tmux.agentSession).toBe('agent-web-STA-1');
	} else {
		// With the database a space has no identity until it is recorded.
		expect(api.kind).toBe('unknown');
		expect(web.kind).toBe('unknown');
	}
});

test('each repo’s own stores still protect its sessions by its own keys', async () => {
	const {all, api} = fixture();
	await all.registry.add('api:STA-1');
	// The reaper runs per repo, on that repo's stores.
	const owned = protectedSessionNames(api.registry, api.spaceIdentities);
	if (owned.kind === 'names') expect(owned.keys.has('STA-1')).toBe(true);
	else expect(owned.kind).toBe('missing');
	const protectedSpaces = all.registry.protectedSpaces();
	expect(protectedSpaces.ok && protectedSpaces.keys).toEqual(['api:STA-1']);
});

test('space state is written to and read from the space’s repo', async () => {
	const {all, api, web} = fixture();
	await all.spaceState.write('api:STA-1', {issueTitle: 'In api'});
	await all.spaceState.writeMany([
		{key: 'web:STA-1', patch: {issueTitle: 'In web'}},
		{key: 'api:STA-2', patch: {issueTitle: 'Also api'}},
	]);
	expect(api.spaceState.read('STA-1')?.issueTitle).toBe('In api');
	expect(api.spaceState.read('STA-2')?.issueTitle).toBe('Also api');
	expect(web.spaceState.read('STA-1')?.issueTitle).toBe('In web');
	expect(all.spaceState.read('web:STA-1')?.issueTitle).toBe('In web');
	expect(all.spaceState.read('web:STA-2')).toBeNull();
});

test('a companion width is kept with its space’s repo', async () => {
	const {all, api, web} = fixture();
	await all.companionWidths.set('api:STA-1', 60);
	await all.companionWidths.set('web:STA-1', '40%');
	expect(api.companionWidths.get('STA-1')).toBe(60);
	expect(web.companionWidths.get('STA-1')).toBe('40%');
	expect(all.companionWidths.get('web:STA-1')).toBe('40%');
	expect(all.companionWidths.all()).toEqual({
		'api:STA-1': 60,
		'web:STA-1': '40%',
	});
});

/** The requests the stores report within a moment of `act`. */
async function highlightsAfter(
	all: StateDaos,
	act: () => Promise<void>,
	count: number,
): Promise<HighlightRequest[]> {
	const seen: HighlightRequest[] = [];
	const stop = all.highlight.watch(request => seen.push(request));
	teardown(stop);
	await act();
	const deadline = Date.now() + 5000;
	while (seen.length < count && Date.now() < deadline)
		await new Promise(resolve => {
			setTimeout(resolve, 20);
		});
	return seen;
}

test('a highlight asked for in one repo reaches the rail under that repo’s name', async () => {
	const {all, web, own} = fixture();
	const seen = await highlightsAfter(
		all,
		async () => {
			// `lasagna highlight` in a space of web, and the sous-chef key.
			await web.highlight.request({issueKey: 'WEB-2', focus: false});
			await own.daos.highlight.request({issueKey: 'main', focus: true});
		},
		2,
	);
	expect(
		new Set(seen.map(request => `${request.issueKey} ${request.focus}`)),
	).toEqual(new Set(['web:WEB-2 false', '@work:main true']));
});

test('a highlight request made by name goes to that repo’s store', async () => {
	const {all} = fixture();
	const seen = await highlightsAfter(
		all,
		async () => all.highlight.request({issueKey: 'api:STA-1', focus: false}),
		1,
	);
	expect(seen.map(request => request.issueKey)).toEqual(['api:STA-1']);
});

test('agent sessions are listed across repos by repo:KEY', () => {
	const {all} = fixture();
	expect(all.agentSessions.keys()).toEqual([]);
	expect(all.agentSessions.read('api:STA-1', 'claude')).toBeUndefined();
});

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

const wakeUp = (id: string, key: string): Job => ({
	kind: 'at',
	id,
	key,
	at: '2026-11-27T08:00:00.000Z',
	message: 'carry on',
	arm: 0,
});

test('every repo’s holds are on one list by repo:KEY, and an id is found in whichever repo has it', async () => {
	const {all, own, api, web} = fixture();
	await api.holds.save(hold('h-api', 'STA-1'));
	await web.holds.save(hold('h-web', 'STA-1'));
	await own.daos.holds.save(hold('h-own', 'main'));
	expect(
		new Set(all.holds.list().map(each => `${each.id} ${each.key}`)),
	).toEqual(
		new Set(['h-own @work:main', 'h-api api:STA-1', 'h-web web:STA-1']),
	);
	expect(all.holds.load('h-web')?.key).toBe('web:STA-1');
	expect(all.holds.load('h-nobody')).toBeNull();
	// Saved back under its full name, it lands in its own repo under its key.
	await all.holds.save({...all.holds.load('h-web')!, state: 'dismissed'});
	expect(web.holds.load('h-web')).toMatchObject({
		key: 'STA-1',
		state: 'dismissed',
	});
	expect(api.holds.load('h-web')).toBeNull();
});

test('every repo’s wake-ups are on one list by repo:KEY, and each is kept in its own repo', async () => {
	const {all, own, api, web} = fixture();
	await api.schedules.save(wakeUp('job-api', 'STA-1'));
	await all.schedules.save(wakeUp('job-web', 'web:WEB-2'));
	expect(web.schedules.load('job-web')?.key).toBe('WEB-2');
	expect(own.daos.schedules.list()).toEqual([]);
	expect(
		new Set(all.schedules.list().map(job => `${job.id} ${job.key}`)),
	).toEqual(new Set(['job-api api:STA-1', 'job-web web:WEB-2']));
	expect(all.schedules.load('job-api')?.key).toBe('api:STA-1');
	await all.schedules.queue('api:STA-1', 'and then this');
	expect(api.schedules.queued('STA-1')).toBe('and then this');
	expect(all.schedules.queued('api:STA-1')).toBe('and then this');
	await all.schedules.delete('job-api');
	expect(api.schedules.load('job-api')).toBeNull();
	expect(all.schedules.load('job-web')).not.toBeNull();
});

test('the stores that are about the TUI itself are the work dir’s own', () => {
	const {all, own} = fixture();
	expect(all.tuiMarker).toBe(own.daos.tuiMarker);
	expect(all.updateCheck).toBe(own.daos.updateCheck);
	// Hook status is one store for every repo, under repo-qualified keys.
	expect(all.claudeStatus).toBe(own.daos.claudeStatus);
});
