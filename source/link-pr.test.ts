import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {testState} from '../test/helpers/state.ts';
import {linkPr, type LinkExecutor} from './link-pr.ts';
import {createStateDaos} from './state-daos.ts';
import {discoverWorkspaceRepositories} from './providers/workspace-repositories.ts';

/** Stores for the repo named `workspace`, which every workspace here is in. */
function stores(sqlite?: boolean) {
	const {daos, stateDir} = testState({repo: 'workspace', sqlite});
	const spaceStateFor = (repoName: string) => {
		expect(repoName).toBe('workspace');
		return daos.spaceState;
	};

	return {
		spaceState: daos.spaceState,
		prLinkStamp: daos.prLinkStamp,
		stateDir,
		options: {
			daosFor(repoName: string) {
				expect(repoName).toBe('workspace');
				return daos;
			},
		},
		discover: async (directory: string) =>
			discoverWorkspaceRepositories(directory, 'github.com', spaceStateFor),
	};
}

// With the database, link-pr is often the first write that finds a space's
// file: idow or an earlier Pappardelle saved the profile there.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: links a fork PR, preserves state, replaces repeated links and follows the published branch`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-pr-'));
		teardown(() => fs.rmSync(root, {recursive: true, force: true}));
		const workspace = path.join(root, 'workspace');
		const {spaceState, prLinkStamp, options, discover} = stores(sqlite);
		fs.mkdirSync(workspace);
		const git = (args: string[]) =>
			execFileSync('git', args, {cwd: workspace, encoding: 'utf-8'}).trim();
		git(['init', '-b', 'STE-24']);
		git(['remote', 'add', 'origin', 'git@github.com:user/fork.git']);
		let remoteBranch = 'published';
		const run: LinkExecutor = async (command, args) => {
			if (command === 'git') return git(args);
			expect(command).toBe('gh');
			expect(args).toStrictEqual([
				'api',
				'--hostname',
				'github.com',
				'repos/upstream/repo/pulls/28',
			]);
			return JSON.stringify({
				state: 'open',
				number: 28,
				head: {ref: remoteBranch, repo: {full_name: 'user/fork'}},
			});
		};
		const file = spaceState.file('STE-24');
		fs.mkdirSync(path.dirname(file), {recursive: true});
		fs.writeFileSync(
			file,
			JSON.stringify({profile: 'codex', pipeline: 'passing'}),
		);
		const url = 'https://github.com/upstream/repo/pull/28';
		expect(prLinkStamp.read()).toBe(0);
		const linked = await linkPr(url, workspace, workspace, {...options, run});
		expect(linked.file).toBe(file);
		expect(prLinkStamp.read() > 0).toBe(true);
		remoteBranch = 'published-again';
		await linkPr(url, workspace, workspace, {...options, run});
		for (const saved of [
			spaceState.read('STE-24')!,
			JSON.parse(fs.readFileSync(file, 'utf8')) as {prLinks?: unknown[]},
		]) {
			expect(saved).toMatchObject({profile: 'codex', pipeline: 'passing'});
			expect(saved.prLinks?.length).toBe(1);
		}

		expect(await discover(workspace)).toStrictEqual([
			{project: 'user/fork', branch: 'published-again'},
		]);
		git(['symbolic-ref', 'HEAD', 'refs/heads/other']);
		expect(await discover(workspace)).toStrictEqual([
			{project: 'user/fork', branch: 'other'},
		]);
	});
}

test('links an upstream PR whose head is a fork added beside origin, and rejects a third repo', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-pr-upstream-'));
	teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	const workspace = path.join(root, 'workspace');
	const {options, discover} = stores();
	fs.mkdirSync(workspace);
	const git = (args: string[]) =>
		execFileSync('git', args, {cwd: workspace, encoding: 'utf-8'}).trim();
	git(['init', '-b', 'STE-24']);
	git(['remote', 'add', 'origin', 'git@github.com:upstream/repo.git']);
	git(['remote', 'add', 'fork', 'git@github.com:user/fork']);
	let head = 'user/fork';
	const run: LinkExecutor = async (command, args) => {
		if (command === 'git') return git(args);
		// Trimmed from `gh api repos/chardigio/pappardelle/pulls/58`.
		return JSON.stringify({
			base: {ref: 'main', repo: {full_name: 'upstream/repo'}},
			head: {ref: 'published', repo: {full_name: head}},
			number: 28,
			state: 'open',
		});
	};
	const url = 'https://github.com/upstream/repo/pull/28';
	await linkPr(url, workspace, workspace, {...options, run});
	expect(await discover(workspace)).toStrictEqual([
		{project: 'user/fork', branch: 'published'},
	]);

	head = 'other/repo';
	await rejectionOf(linkPr(url, workspace, workspace, {...options, run})).then(
		error => {
			expect(error.message).toBe(
				'Run link-pr from the source repository (github.com/other/repo)',
			);
		},
	);
});

test('GitLab nested repositories retain independent branch mappings', async () => {
	const {spaceState, options} = stores();
	const calls: string[] = [];
	const run: LinkExecutor = async (command, args, cwd) => {
		if (command === 'glab') {
			expect(args[2]).toBe('gitlab.example.com');
			calls.push(args.at(-1)!);
			return JSON.stringify(
				args.at(-1)!.includes('merge_requests')
					? {
							state: 'opened',
							iid: 7,
							source_project_id: 12,
							source_branch: 'published',
							web_url:
								'https://gitlab-web.example.com/group/sub/repo/-/merge_requests/7',
						}
					: {path_with_namespace: 'group/sub/repo'},
			);
		}
		if (args[0] === 'config')
			return 'remote.origin.url git@gitlab.example.com:group/sub/repo.git';
		if (args[0] === 'rev-parse') return '/repos/workspace/.git';
		return cwd === '/workspace' ? 'ISSUE-1' : 'local';
	};
	await spaceState.addPrLink('ISSUE-1', {
		host: 'gitlab.example.com',
		project: 'group/other',
		localBranch: 'local',
		remoteBranch: 'other',
		url: 'https://gitlab.example.com/group/other/-/merge_requests/8',
		number: 8,
	});
	await linkPr(
		'https://gitlab-web.example.com/group/sub/repo/-/merge_requests/7',
		'/workspace/src/repo',
		'/workspace',
		{...options, run, gitlabHost: 'gitlab.example.com'},
	);
	expect(calls).toStrictEqual([
		'projects/group%2Fsub%2Frepo/merge_requests/7',
		'projects/12',
	]);
	expect(spaceState.read('ISSUE-1')?.prLinks?.length).toBe(2);
});

test('failed verification and unrelated source repositories do not write state', async () => {
	const {stateDir, options} = stores();
	const run: LinkExecutor = async command => {
		if (command === 'gh')
			return JSON.stringify({
				state: 'open',
				number: 1,
				head: {ref: 'feature', repo: {full_name: 'other/repo'}},
			});
		return 'git@github.com:user/repo.git';
	};
	expect(
		await rejectionOf(
			linkPr(
				'https://github.com/user/repo/pull/1',
				'/workspace',
				'/workspace',
				{
					...options,
					run,
				},
			),
		),
	).toHaveProperty('message', expect.stringMatching(/source repository/));
	await rejectionOf(
		linkPr('https://github.com/user/repo/pull/1', '/workspace', '/workspace', {
			...options,
			async run() {
				throw new Error('API unavailable');
			},
		}),
	).then(error => {
		expect(error.message).toBe('API unavailable');
	});
	expect(
		fs.existsSync(path.join(stateDir, 'repos', 'workspace', 'space-state')),
	).toBe(false);
	expect(fs.existsSync(path.join(stateDir, 'pr-link.stamp'))).toBe(false);
});

test('a PR linked from a repo in a ticket folder is recorded for the ticket space, and for that repo', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-pr-'));
	teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	// The folder is no checkout; the repo's worktree in it is.
	const folder = path.join(root, '_tickets', 'B2B-5');
	const worktree = path.join(folder, 'api');
	fs.mkdirSync(worktree, {recursive: true});
	const git = (args: string[]) =>
		execFileSync('git', args, {cwd: worktree, encoding: 'utf-8'}).trim();
	git(['init', '-b', 'B2B-5']);
	git(['remote', 'add', 'origin', 'git@github.com:acme/api.git']);
	const run: LinkExecutor = async (command, args) => {
		if (command === 'git') return git(args);
		return JSON.stringify({
			state: 'open',
			number: 41,
			head: {ref: 'B2B-5', repo: {full_name: 'acme/api'}},
		});
	};

	const work = testState({repo: '@work'});
	// The repo's stores beside the work dir's, as one HOME keeps them.
	const api = createStateDaos({
		repo: 'api',
		stateDir: work.stateDir,
		sqlite: work.sqlite,
	});
	teardown(() => api.disconnectStatusDaemon());
	const linked = await linkPr(
		'https://github.com/acme/api/pull/41',
		worktree,
		folder,
		{
			daosFor: repoName => (repoName === '@work' ? work.daos : api),
			run,
			space: {repoName: '@work', issueKey: 'B2B-5', memberRepo: 'api'},
		},
	);
	expect(linked.file).toBe(work.daos.spaceState.file('B2B-5'));
	const link = {
		host: 'github.com',
		project: 'acme/api',
		localBranch: 'B2B-5',
		remoteBranch: 'B2B-5',
		url: 'https://github.com/acme/api/pull/41',
		number: 41,
	};
	expect(work.daos.spaceState.read('B2B-5')?.prLinks).toStrictEqual([link]);
	// The repo's own status is read by its worktree, which finds the link here.
	expect(api.spaceState.read('B2B-5')?.prLinks).toStrictEqual([link]);

	// From the folder itself there is no repo for the PR to be in.
	const outside = await rejectionOf(
		linkPr('https://github.com/acme/api/pull/41', folder, folder, {
			daosFor: () => work.daos,
			async run(command, args) {
				if (command === 'git')
					return execFileSync('git', args, {cwd: folder, encoding: 'utf-8'});
				return JSON.stringify({
					state: 'open',
					number: 41,
					head: {ref: 'B2B-5', repo: {full_name: 'acme/api'}},
				});
			},
			space: {repoName: '@work', issueKey: 'B2B-5', memberRepo: 'api'},
		}),
	);
	expect(outside).toBeInstanceOf(Error);
});
