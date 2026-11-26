import {test, expect} from 'bun:test';
import path from 'node:path';
import {testState} from '../test/helpers/state.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {formatSpaces, type SpacesDeps} from './spaces-command.ts';
import {createStateDaos} from './state-daos.ts';
import {gatherWorkdirSpaces} from './workdir-spaces.ts';

/** Two repos' stores in one state directory, as one HOME keeps them. */
function fixture() {
	const home = tempDir('lasagna-workdir-spaces-');
	const stateDir = path.join(home, '.lasagna');
	const api = testState({repo: 'api', stateDir, home});
	const webDaos = createStateDaos({
		repo: 'web',
		stateDir,
		sqlite: api.sqlite,
		home,
	});
	teardown(() => webDaos.disconnectStatusDaemon());
	const deps = (
		repoName: string,
		daos: typeof webDaos,
		overrides: Partial<SpacesDeps> = {},
	): SpacesDeps => ({
		repoName,
		registry: daos.registry,
		spaceIdentities: daos.spaceIdentities,
		claudeStatus: daos.claudeStatus,
		spaceState: daos.spaceState,
		issueMeta: daos.issueMeta,
		home,
		fetchTitles: async keys =>
			new Map(keys.map(key => [key, `${key} of ${repoName}`])),
		gitSummary: async () => null,
		...overrides,
	});
	return {api: api.daos, web: webDaos, deps};
}

test('the board of a work dir lists every repo’s open spaces by repo:KEY', async () => {
	const {api, web, deps} = fixture();
	await api.registry.add('B2B-12');
	await api.registry.add('API-7');
	await web.registry.add('B2B-12');
	const report = await gatherWorkdirSpaces([
		deps('api', api),
		deps('web', web),
	]);
	if ('error' in report) throw new Error(report.error);
	expect(report.totalSpaces).toBe(3);
	expect(new Set(report.spaces.map(space => space.name))).toEqual(
		new Set(['api:B2B-12', 'api:API-7', 'web:B2B-12']),
	);
	// The same key is a different issue in each repo.
	const title = (name: string) =>
		report.spaces.find(space => space.name === name)?.title;
	expect(title('api:B2B-12')).toBe('B2B-12 of api');
	expect(title('web:B2B-12')).toBe('B2B-12 of web');
	expect(formatSpaces(report)).toContain('web:B2B-12');
});

test('a repo that never had a space adds nothing to the board', async () => {
	const {api, web, deps} = fixture();
	await api.registry.add('API-7');
	const report = await gatherWorkdirSpaces([
		deps('api', api),
		deps('web', web),
	]);
	expect('error' in report).toBe(false);
	expect(report.spaces.map(space => space.name)).toEqual(['api:API-7']);
});

test('a work dir with no spaces says so', async () => {
	const {api, web, deps} = fixture();
	const report = await gatherWorkdirSpaces([
		deps('api', api),
		deps('web', web),
	]);
	expect(formatSpaces(report)).toBe('No open spaces');
});

test('a repo whose spaces cannot be read fails the board, by name', async () => {
	const {api, web, deps} = fixture();
	await api.registry.add('API-7');
	const report = await gatherWorkdirSpaces([
		deps('api', api),
		deps('web', web, {
			registry: {
				openSpaces() {
					throw new Error('disk on fire');
				},
			},
		}),
	]);
	expect(report).toEqual({
		error: 'web: Could not read the open spaces: disk on fire',
		spaces: [],
	});
});
