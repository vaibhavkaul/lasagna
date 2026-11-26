import {test, expect} from 'bun:test';
import path from 'node:path';
import {thrownBy} from '../test/helpers/thrown.ts';
import {writeFiles} from '../test/helpers/config-fixtures.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	loadConfigFromPaths,
	loadRawMergedConfig,
	readConfigLayers,
	type ConfigPaths,
} from './config.ts';
import {ConfigNotFoundError, ConfigValidationError} from './config-errors.ts';
import {planConfigMigrations} from './config-migration.ts';
import {
	findWorkdir,
	mainCheckoutHasConfig,
	workdirListsRepo,
} from './repo-config-files.ts';

const PROFILES = 'profiles:\n  t:\n    display_name: T\n';

/**
 * A home dir and a work dir holding the repo `api`, with each file written
 * at its path relative to the work dir; `~/` names one in the home dir.
 */
function workdirFixture(files: Record<string, string>): {
	work: string;
	repo: string;
	paths: ConfigPaths;
} {
	const root = tempDir('lasagna-workdir-');
	const home = path.join(root, 'home');
	const work = path.join(root, 'work');
	const repo = path.join(work, 'api');
	writeFiles(home, {'.keep': ''});
	writeFiles(repo, {'.keep': ''});
	for (const [name, content] of Object.entries(files)) {
		if (name.startsWith('~/')) {
			writeFiles(home, {[name.slice(2)]: content});
		} else {
			writeFiles(work, {[name]: content});
		}
	}

	return {
		work,
		repo,
		paths: {
			homeConfigDir: home,
			workdir: () => findWorkdir(repo, {}),
			repoName: () => 'api',
			projectDir: repo,
			fallbackProjectDir: () => repo,
		},
	};
}

test('layers apply lowest first: home, workdir, inferred, repo section, project, local', () => {
	const layers = [
		['~/.pappardelle.yml', 'home'],
		['.lasagna/workdir.yml', 'workdir'],
		['inferred', 'inferred'],
		['section', 'section'],
		['api/.pappardelle.yml', 'project'],
		['api/.pappardelle.local.yml', 'local'],
	] as const;
	// Each layer sets the field of its own name and every field of the layers
	// above it, so the winner of each field is the highest layer that sets it.
	const fieldsFrom = (index: number) =>
		layers
			.slice(index)
			.map(([, name]) => `${name}: ${layers[index]![1]}`)
			.join('\n');
	const files: Record<string, string> = {};
	const sectionText = (index: number) =>
		fieldsFrom(index)
			.split('\n')
			.map(line => `      ${line}`)
			.join('\n');
	for (const [index, [file]] of layers.entries()) {
		if (file === 'inferred' || file === 'section') continue;
		files[file] = `${fieldsFrom(index)}\n`;
	}

	files['.lasagna/workdir.yml'] = [
		fieldsFrom(1),
		'repos:',
		'  api:',
		'    inferred:',
		'      config:',
		sectionText(2).replaceAll(/^ {6}/gm, '        '),
		sectionText(3).replaceAll(/^ {6}/gm, '    '),
		'',
	].join('\n');
	files['api/.pappardelle.yml'] = `version: 1\n${PROFILES}${fieldsFrom(4)}\n`;

	const merged = loadRawMergedConfig(workdirFixture(files).paths);

	expect(
		Object.fromEntries(layers.map(([, name]) => [name, merged[name]])),
	).toStrictEqual({
		home: 'home',
		workdir: 'workdir',
		inferred: 'inferred',
		section: 'section',
		project: 'project',
		local: 'local',
	});
});

test("another repo's section applies nothing", () => {
	const {paths} = workdirFixture({
		'.lasagna/workdir.yml':
			'team_prefix: ALL\nrepos:\n  web:\n    team_prefix: WEB\n',
		'api/.pappardelle.yml': `version: 1\n${PROFILES}`,
	});

	expect(loadConfigFromPaths(paths).team_prefix).toBe('ALL');
	expect(
		readConfigLayers(paths)
			.filter(file => file.kind === 'read')
			.map(file => file.label),
	).toStrictEqual(['.lasagna/workdir.yml', '.pappardelle.yml']);
});

test("the working tree's file wins over the main checkout's", () => {
	const {paths, work} = workdirFixture({
		'api/.pappardelle.yml': `version: 1\n${PROFILES}team_prefix: MAIN\n`,
		'tree/.pappardelle.yml': `version: 1\n${PROFILES}team_prefix: TREE\n`,
	});

	expect(
		loadConfigFromPaths({...paths, projectDir: path.join(work, 'tree')})
			.team_prefix,
	).toBe('TREE');
});

test("inferred values give way to the user's in the same section, and sources are merged nowhere", () => {
	const {paths} = workdirFixture({
		'.lasagna/workdir.yml': [
			'repos:',
			'  api:',
			'    team_prefix: MINE',
			'    inferred:',
			'      config:',
			'        version: 1',
			'        team_prefix: GUESS',
			'        default_emoji: guessed',
			'        profiles:',
			'          t:',
			'            display_name: T',
			'      sources:',
			'        team_prefix:',
			'          source: branch names (41)',
			'          confidence: high',
			'',
		].join('\n'),
	});

	const merged = loadRawMergedConfig(paths);

	expect([
		merged['team_prefix'],
		merged['default_emoji'],
		'sources' in merged,
		'inferred' in merged,
		'repos' in merged,
	]).toStrictEqual(['MINE', 'guessed', false, false, false]);
});

test('a malformed workdir file is reported, whichever repo it is wrong for', () => {
	const {paths} = workdirFixture({
		'.lasagna/workdir.yml': [
			'repos:',
			'  web:',
			'    inferred:',
			'      config: nope',
			'      guesses: {}',
			'      sources:',
			'        team_prefix:',
			'          confidence: sure',
			'',
		].join('\n'),
		'api/.pappardelle.yml': `version: 1\n${PROFILES}`,
	});

	const error = thrownBy(() => loadConfigFromPaths(paths));

	expect(error).toBeInstanceOf(ConfigValidationError);
	expect((error as ConfigValidationError).errors).toStrictEqual([
		'.lasagna/workdir.yml: repos.web.inferred.guesses is not a setting: inferred holds only config and sources',
		'.lasagna/workdir.yml: repos.web.inferred.config must be a map',
		'.lasagna/workdir.yml: repos.web.inferred.sources.team_prefix.source must be a non-empty string',
		'.lasagna/workdir.yml: repos.web.inferred.sources.team_prefix.confidence must be one of high, medium, low',
	]);
});

test("an invalid value in the repo's section names the section", () => {
	const {paths} = workdirFixture({
		'.lasagna/workdir.yml': 'repos:\n  api:\n    default_emoji: [1]\n',
		'api/.pappardelle.yml': `version: 1\n${PROFILES}`,
	});

	const error = thrownBy(() => loadConfigFromPaths(paths));

	expect((error as ConfigValidationError).errors.join('\n')).toContain(
		'.lasagna/workdir.yml repos.api: default_emoji: must be a string',
	);
});

test('a repo is configured by a project file or a section of its own, not by top-level workdir settings', () => {
	const project = `version: 1\n${PROFILES}`;
	const topOnly = workdirFixture({
		'.lasagna/workdir.yml': project,
	});
	expect(thrownBy(() => loadRawMergedConfig(topOnly.paths))).toBeInstanceOf(
		ConfigNotFoundError,
	);
	expect(mainCheckoutHasConfig(topOnly.repo)).toBe(false);

	const listed = workdirFixture({
		'.lasagna/workdir.yml': `${project}repos:\n  api:\n`,
	});
	expect(loadRawMergedConfig(listed.paths)['version']).toBe(1);
	expect(mainCheckoutHasConfig(listed.repo)).toBe(true);
});

test('the workdir is the nearest work dir above the main checkout, or LASAGNA_WORKDIR', () => {
	const {work, repo} = workdirFixture({'.lasagna/workdir.yml': 'repos: {}\n'});
	const outer = path.dirname(work);
	writeFiles(outer, {'.lasagna/workdir.yml': ''});

	expect(findWorkdir(repo, {})).toBe(work);
	expect(findWorkdir(work, {})).toBe(work);
	expect(findWorkdir(outer, {})).toBe(outer);
	expect(findWorkdir(path.dirname(outer), {})).toBeUndefined();
	expect(findWorkdir(repo, {LASAGNA_WORKDIR: outer})).toBe(outer);
	expect(findWorkdir(repo, {LASAGNA_WORKDIR: ''})).toBeUndefined();
});

test('workdirListsRepo reads the file as YAML, not as text', () => {
	const {work} = workdirFixture({
		'.lasagna/workdir.yml': [
			'# api: is only a comment here',
			'repos:',
			'  web:',
			'    api:',
			'      nested: true',
			'  "quoted":',
			'    team_prefix: Q',
			'',
		].join('\n'),
	});

	expect(
		['api', 'web', 'quoted'].map(name => workdirListsRepo(work, name)),
	).toStrictEqual([false, true, true]);
});

test('config migrations never rewrite the workdir file', () => {
	const {paths} = workdirFixture({
		'.lasagna/workdir.yml': 'repos:\n  api:\n    claude:\n      model: opus\n',
		'api/.pappardelle.yml': `version: 1\n${PROFILES}`,
	});

	const plan = planConfigMigrations(paths);

	expect(plan).toStrictEqual({
		kind: 'unsupported',
		reason:
			'.lasagna/workdir.yml repos.api uses the old format, and the workdir config is only edited by hand',
	});
});
