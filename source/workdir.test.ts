import {test, expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {writeFiles} from '../test/helpers/config-fixtures.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {thrownBy} from '../test/helpers/thrown.ts';
import {loadConfigFromPaths, type ConfigPaths} from './config.ts';
import {ConfigValidationError} from './config-errors.ts';
import {
	readWorkdir,
	workdirAt,
	workdirRepoRoot,
	workdirRepos,
} from './workdir.ts';

const PROFILES = 'version: 1\nprofiles:\n  t:\n    display_name: T\n';

function workdir(config: string, directories: string[]): string {
	const work = path.join(tempDir('lasagna-workdir-list-'), 'work');
	writeFiles(work, {'.lasagna/workdir.yml': config});
	for (const directory of directories)
		fs.mkdirSync(path.join(work, directory), {recursive: true});
	return work;
}

test('a work dir lists the repos of its config whose directories exist, in file order', () => {
	const work = workdir(
		`${PROFILES}repos:\n  web:\n  api:\n    team_prefix: API\n  gone:\n`,
		['api', 'web', 'unlisted'],
	);
	expect(workdirRepos(work)).toEqual([
		{name: 'web', root: path.join(work, 'web')},
		{name: 'api', root: path.join(work, 'api')},
	]);
});

test('a repo section can say where its checkout is', () => {
	const work = workdir(
		`${PROFILES}repos:\n  api:\n    path: services/api\n  web:\n`,
		['services/api', 'web'],
	);
	expect(workdirRepos(work)).toEqual([
		{name: 'api', root: path.join(work, 'services/api')},
		{name: 'web', root: path.join(work, 'web')},
	]);
});

test('a repo path can be absolute or start at the home directory', () => {
	expect(workdirRepoRoot('/work', 'api', {path: '/elsewhere/api'})).toBe(
		'/elsewhere/api',
	);
	expect(
		workdirRepoRoot('/work', 'api', {path: '~/code/api'}, '/home/me'),
	).toBe('/home/me/code/api');
	expect(workdirRepoRoot('/work', 'api', null)).toBe('/work/api');
});

test('a work dir whose config cannot be parsed, or lists no repos, has none', () => {
	expect(workdirRepos(workdir('repos: [not, a, map]\n', ['api']))).toEqual([]);
	expect(workdirRepos(workdir(': : :\n', ['api']))).toEqual([]);
	expect(workdirRepos(workdir(PROFILES, ['api']))).toEqual([]);
	expect(workdirRepos(tempDir('lasagna-no-workdir-'))).toEqual([]);
});

test('a work dir is named after its directory, with @ for its own spaces', () => {
	const work = workdir(`${PROFILES}repos:\n  api:\n`, ['api']);
	expect(readWorkdir(work)).toEqual({
		root: work,
		repoName: '@work',
		repos: [{name: 'api', root: path.join(work, 'api')}],
	});
});

test('the work dir of a directory is the nearest one above it', () => {
	const work = workdir(`${PROFILES}repos:\n  api:\n`, ['api/src']);
	expect(workdirAt(path.join(work, 'api', 'src'), {})?.root).toBe(work);
	expect(workdirAt(tempDir('lasagna-no-workdir-'), {})).toBeUndefined();
	// LASAGNA_WORKDIR names it from anywhere, and empty turns it off.
	expect(workdirAt('/', {LASAGNA_WORKDIR: work})?.root).toBe(work);
	expect(
		workdirAt(path.join(work, 'api'), {LASAGNA_WORKDIR: ''}),
	).toBeUndefined();
});

function pathsFor(work: string, repo: string): ConfigPaths {
	return {
		homeConfigDir: path.join(work, 'no-home'),
		workdir: () => work,
		repoName: () => repo,
		projectDir: path.join(work, repo),
		fallbackProjectDir: () => path.join(work, repo),
	};
}

test('a repo section\u2019s path locates the repo and is not one of its settings', () => {
	const work = workdir(
		`${PROFILES}repos:\n  api:\n    path: services/api\n    team_prefix: API\n`,
		['services/api'],
	);
	const config = loadConfigFromPaths(pathsFor(work, 'api'));
	expect(config.team_prefix).toBe('API');
	expect(config).not.toHaveProperty('path');
});

test('a repo section\u2019s path must be a non-empty string', () => {
	const work = workdir(`${PROFILES}repos:\n  api:\n    path: [a, b]\n`, [
		'api',
	]);
	const error = thrownBy(() => loadConfigFromPaths(pathsFor(work, 'api')));
	expect(error).toBeInstanceOf(ConfigValidationError);
	expect((error as ConfigValidationError).errors).toEqual([
		'.lasagna/workdir.yml: repos.api.path must be a non-empty string',
	]);
});
