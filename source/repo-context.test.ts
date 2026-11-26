import {test, expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {thrownBy} from '../test/helpers/thrown.ts';
import {
	git,
	listRepos,
	workdirFixture,
} from '../test/helpers/workdir-fixture.ts';
import {
	configExists,
	expandTemplate,
	getMainRepoRoot,
	getRepoName,
	getRepoRoot,
	getTeamPrefix,
	repoRootsAt,
	setDefaultRepo,
	shouldInclude,
	workdirRepoRoots,
} from './config.ts';
import {NotInGitRepoError} from './config-errors.ts';
import {
	defaultRepoContext,
	repoContext,
	resetRepoContexts,
	workdirRepoContext,
} from './repo-context.ts';
import {bunIsolationArgs} from './runtime.ts';

const PROFILES = 'profiles:\n  t:\n    display_name: T\n';

function twoRepos() {
	teardown(resetRepoContexts);
	return workdirFixture({
		repos: {
			api: {
				'.pappardelle.yml': `version: 1\nteam_prefix: API\n${PROFILES}`,
				'.envrc':
					'export TRACKER_TOKEN=token-of-api\nexport ONLY_API=1\nexport HOME=/not/used\n',
			},
			web: {
				'.pappardelle.yml': `version: 1\nteam_prefix: WEB\n${PROFILES}`,
				'.envrc': 'export TRACKER_TOKEN=token-of-web\nexport ONLY_WEB=1\n',
			},
		},
	});
}

function teamPrefix(root: string): string {
	const load = repoContext(root).readConfig();
	if (load.kind !== 'valid') throw new Error(`config is ${load.kind}`);
	return getTeamPrefix(load.config);
}

test('a repo context names the checkout it was asked for', () => {
	const {repos} = twoRepos();
	const api = repoContext(repos['api']!.root);
	expect(api.root).toBe(repos['api']!.root);
	expect(api.mainRoot).toBe(repos['api']!.root);
	expect(api.name).toBe(repos['api']!.name);
	expect(repoContext(repos['web']!.root).name).toBe(repos['web']!.name);
});

test('a repo context is built once per directory', () => {
	const {repos} = twoRepos();
	expect(repoContext(repos['api']!.root)).toBe(repoContext(repos['api']!.root));
	expect(repoContext(repos['api']!.root)).not.toBe(
		repoContext(repos['web']!.root),
	);
});

test("a linked worktree's context keeps its own root and names the main checkout", () => {
	const {repos, work} = twoRepos();
	const worktree = path.join(work, 'elsewhere', 'API-7');
	git(repos['api']!.root, 'worktree', 'add', '-q', '-b', 'API-7', worktree);
	const context = repoContext(worktree);
	expect(context.root).toBe(worktree);
	expect(context.mainRoot).toBe(repos['api']!.root);
	expect(context.name).toBe(repos['api']!.name);
});

test('each repo reads its own config', () => {
	const {repos} = twoRepos();
	expect(teamPrefix(repos['api']!.root)).toBe('API');
	expect(teamPrefix(repos['web']!.root)).toBe('WEB');
});

test("each repo's environment holds its own .envrc and never the other's", () => {
	const {repos} = twoRepos();
	const api = repoContext(repos['api']!.root).env;
	const web = repoContext(repos['web']!.root).env;
	expect(api['TRACKER_TOKEN']).toBe('token-of-api');
	expect(web['TRACKER_TOKEN']).toBe('token-of-web');
	expect(api['ONLY_API']).toBe('1');
	expect(api['ONLY_WEB']).toBeUndefined();
	expect(web['ONLY_WEB']).toBe('1');
	expect(web['ONLY_API']).toBeUndefined();
});

test("a repo's .envrc is not written into the process's environment", () => {
	const {repos} = twoRepos();
	expect(repoContext(repos['api']!.root).env['ONLY_API']).toBe('1');
	expect(process.env['TRACKER_TOKEN']).toBeUndefined();
	expect(process.env['ONLY_API']).toBeUndefined();
});

test("a variable in a command template is read from the repo's environment, .envrc included", () => {
	const {repos} = twoRepos();
	const {env} = repoContext(repos['api']!.root);
	const vars = {
		ISSUE_KEY: 'API-1',
		WORKTREE_PATH: '/wt',
		REPO_ROOT: '/r',
		MAIN_REPO_ROOT: '/r',
		REPO_NAME: 'api',
	};
	// eslint-disable-next-line no-template-curly-in-string -- a keybinding template
	const template = 'deploy ${ISSUE_KEY} --token ${TRACKER_TOKEN}';
	expect(expandTemplate(template, vars, env)).toBe(
		'deploy API-1 --token token-of-api',
	);
	expect(shouldInclude('ONLY_API', vars, env)).toBe(true);
	expect(shouldInclude('ONLY_WEB', vars, env)).toBe(false);
	// Without the repo's environment only the process's own is read.
	expect(expandTemplate(template, vars)).toBe('deploy API-1 --token ');
});

/** What a process started in `cwd` has for `names` in its own repo's environment. */
function ownEnvironment(
	cwd: string,
	inherited: Record<string, string>,
	names: string[],
): Array<string | undefined> {
	const script = `
		import {defaultRepoContext} from ${JSON.stringify(path.join(import.meta.dirname, 'repo-context.ts'))};
		const {env} = defaultRepoContext();
		console.log(JSON.stringify(${JSON.stringify(names)}.map(name => env[name] ?? null)));
	`;
	const result = spawnSync(
		process.execPath,
		[...bunIsolationArgs, '--eval', script],
		{cwd, encoding: 'utf8', env: {...process.env, ...inherited}},
	);
	expect(result.stderr).toBe('');
	return (JSON.parse(result.stdout) as Array<string | null>).map(
		value => value ?? undefined,
	);
}

test('in the checkout the process was started in, a variable it already has wins over .envrc', () => {
	const {repos} = twoRepos();
	expect(
		ownEnvironment(repos['api']!.root, {TRACKER_TOKEN: 'from-the-shell'}, [
			'TRACKER_TOKEN',
			'ONLY_API',
		]),
	).toEqual(['from-the-shell', '1']);
});

test('the .envrc of a repo the process was not started in wins over what the process inherited', () => {
	const {repos} = twoRepos();
	process.env['TRACKER_TOKEN'] = 'inherited-from-elsewhere';
	teardown(() => {
		delete process.env['TRACKER_TOKEN'];
	});
	// As idow has it, which sources the file.
	expect(repoContext(repos['api']!.root).env['TRACKER_TOKEN']).toBe(
		'token-of-api',
	);
	expect(repoContext(repos['web']!.root).env['TRACKER_TOKEN']).toBe(
		'token-of-web',
	);
	// What no .envrc sets is still the process's.
	expect(repoContext(repos['web']!.root).env['PATH']).toBe(process.env['PATH']);
});

test('a process pointed at a repo takes that repo\u2019s .envrc over what it inherited', () => {
	const {repos} = twoRepos();
	teardown(() => {
		setDefaultRepo(undefined);
		delete process.env['TRACKER_TOKEN'];
	});
	process.env['TRACKER_TOKEN'] = 'inherited-from-elsewhere';
	setDefaultRepo(repoRootsAt(repos['web']!.root));
	expect(defaultRepoContext().env['TRACKER_TOKEN']).toBe('token-of-web');
});

test('a directory outside a checkout has no repo context', () => {
	teardown(resetRepoContexts);
	const outside = tempDir('lasagna-no-repo-');
	expect(thrownBy(() => repoContext(outside))).toBeInstanceOf(
		NotInGitRepoError,
	);
});

test("a work dir's pseudo-repo is named @<directory> and rooted at the work dir", () => {
	teardown(resetRepoContexts);
	const {work, workRepo} = workdirFixture({
		repos: {api: {}},
		workdirConfig: listRepos,
	});
	const context = workdirRepoContext(work);
	expect(context.name).toBe(workRepo);
	expect(context.name).toBe(`@${path.basename(work)}`);
	expect(context.root).toBe(work);
	expect(context.mainRoot).toBe(work);
	expect(context.workdir).toBe(work);
});

test("a work dir's pseudo-repo reads the workdir config's top level, not a repo's section", () => {
	teardown(resetRepoContexts);
	const {work, repos} = workdirFixture({
		repos: {api: {}},
		workdirConfig: names =>
			`version: 1\nteam_prefix: TOP\n${PROFILES}repos:\n  ${names['api']}:\n    team_prefix: API\n`,
	});
	const load = workdirRepoContext(work).readConfig();
	expect(load.kind).toBe('valid');
	if (load.kind === 'valid') expect(getTeamPrefix(load.config)).toBe('TOP');
	// The repo listed in it still gets its own section on top.
	const apiLoad = repoContext(repos['api']!.root).readConfig();
	expect(apiLoad.kind).toBe('valid');
	if (apiLoad.kind === 'valid')
		expect(getTeamPrefix(apiLoad.config)).toBe('API');
});

test('setDefaultRepo points the no-argument readers at another repo', () => {
	const {repos} = twoRepos();
	teardown(() => setDefaultRepo(undefined));
	const own = {
		root: getRepoRoot(),
		mainRoot: getMainRepoRoot(),
		name: getRepoName(),
	};
	setDefaultRepo(repoRootsAt(repos['web']!.root));
	expect(getRepoRoot()).toBe(repos['web']!.root);
	expect(getMainRepoRoot()).toBe(repos['web']!.root);
	expect(getRepoName()).toBe(repos['web']!.name);
	expect(defaultRepoContext().name).toBe(repos['web']!.name);
	expect(defaultRepoContext().env['ONLY_WEB']).toBe('1');
	expect(configExists()).toBe(true);
	setDefaultRepo(undefined);
	expect(getRepoRoot()).toBe(own.root);
	expect(getMainRepoRoot()).toBe(own.mainRoot);
	expect(getRepoName()).toBe(own.name);
});

test("a work dir's pseudo-repo is configured when the work dir has a workdir config", () => {
	teardown(resetRepoContexts);
	teardown(() => setDefaultRepo(undefined));
	const configured = workdirFixture({repos: {}, workdirConfig: listRepos});
	setDefaultRepo(workdirRepoRoots(configured.work));
	expect(getRepoName()).toBe(configured.workRepo);
	expect(configExists()).toBe(true);
	const bare = workdirFixture({repos: {}});
	setDefaultRepo(workdirRepoRoots(bare.work));
	expect(configExists()).toBe(false);
});
