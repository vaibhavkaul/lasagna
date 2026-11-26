// The pseudo-repo of a work dir, `@<workdir>`, in the places a repo name
// goes: tmux session names, the per-repo stores and status keys.
import {test, expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {testState} from '../test/helpers/state.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {listRepos, workdirFixture} from '../test/helpers/workdir-fixture.ts';
import {hookStatusKey} from './claude-status.ts';
import {
	isWorkdirRepoName,
	mainCheckoutHasConfig,
	workdirRepoName,
} from './repo-config-files.ts';
import {
	mainIdentity,
	sessionNamesFor,
	sessionPrefix,
	tmuxSessionRepo,
} from './space-identity.ts';
import {getRegistryPathForRepo, listKnownRepos} from './space-registry.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {
	exactSessionTarget,
	getMainWorktreeInfo,
	newOuterSessionArgs,
	outerSessionName,
} from './tmux.ts';
import {tuiSessionNames} from './tui-sessions.ts';

test('a work dir\u2019s pseudo-repo is its directory name behind an @', () => {
	expect(workdirRepoName('/code/com.github.taptapsend')).toBe(
		'@com.github.taptapsend',
	);
	expect(isWorkdirRepoName('@com.github.taptapsend')).toBe(true);
	expect(isWorkdirRepoName('appian-server')).toBe(false);
});

test('@ passes through the session-name spelling, and the rest of the name is spelled as any repo\u2019s', () => {
	expect(tmuxSessionRepo('@work')).toBe('@work');
	expect(tmuxSessionRepo('@com.github.taptapsend')).toBe(
		'@com_github_taptapsend',
	);
	expect(sessionNamesFor(MAIN_WORKTREE_KEY, '@work')).toEqual({
		agent: 'agent-@work-main',
		companion: 'companion-@work-main',
	});
	// No real repo's sessions start with a pseudo-repo's prefix, or the other
	// way round, so neither's reaper sees the other's.
	expect(sessionPrefix('agent', 'work').startsWith('agent-@')).toBe(false);
});

test('tmux keeps a session named for a pseudo-repo, and finds it by that name alone', () => {
	// -S rather than -L: a named socket lands in /tmp/tmux-<uid>, outside TMPDIR.
	const socket = path.join(tempDir('lasagna-at-'), 's');
	const tmux = (...args: string[]) =>
		spawnSync('tmux', ['-S', socket, ...args], {encoding: 'utf-8'});
	if (tmux('-V').error) {
		expect().pass('tmux not installed');
		return;
	}

	try {
		for (const repo of ['@work', '@com.github.taptapsend']) {
			const {agent, companion} = sessionNamesFor(MAIN_WORKTREE_KEY, repo);
			expect(tmux('new-session', '-d', '-s', agent).status).toBe(0);
			expect(tmux('new-session', '-d', '-s', companion).status).toBe(0);
			expect(tmux('has-session', '-t', exactSessionTarget(agent)).status).toBe(
				0,
			);
			// What tmux stored is what was asked for: nothing respelled the @.
			const listed = tmux('list-sessions', '-F', '#{session_name}')
				.stdout.trim()
				.split('\n');
			expect(listed).toContain(agent);
			expect(listed).toContain(companion);
			// A pane of it can be addressed, as the viewers and send-keys do.
			expect(
				tmux(
					'display-message',
					'-p',
					'-t',
					`${exactSessionTarget(agent)}:`,
					'ok',
				).stdout,
			).toBe('ok\n');
			expect(
				tmux('rename-session', '-t', exactSessionTarget(agent), `${agent}x`)
					.status,
			).toBe(0);
		}

		// The same key in a real repo of the same name is another session.
		expect(
			tmux(
				'has-session',
				'-t',
				exactSessionTarget(sessionNamesFor(MAIN_WORKTREE_KEY, 'work').agent),
			).status,
		).not.toBe(0);
	} finally {
		tmux('kill-server');
	}
});

test('a pseudo-repo keeps its spaces in the per-repo stores like any repo', async () => {
	const work = tempDir('lasagna-at-work-');
	const repo = workdirRepoName(work);
	const state = testState({repo, mainRoot: () => work});
	expect(state.registryFile).toBe(
		path.join(state.stateDir, 'repos', repo, 'open-spaces.json'),
	);
	expect(getRegistryPathForRepo(repo, state.stateDir)).toBe(state.registryFile);

	await state.daos.registry.add('B2B-1');
	expect(state.daos.registry.has('B2B-1')).toBe(true);
	expect(state.daos.registry.openSpaces()).toEqual(['B2B-1']);
	await state.daos.spaceState.write('B2B-1', {issueTitle: 'Across repos'});
	expect(state.daos.spaceState.read('B2B-1')?.issueTitle).toBe('Across repos');
	expect(listKnownRepos(state.stateDir)).toContain(repo);
});

test('a pseudo-repo\u2019s main space is the work dir\u2019s root', async () => {
	const work = tempDir('lasagna-at-work-');
	const repo = workdirRepoName(work);
	const {daos} = testState({repo, mainRoot: () => work});
	await daos.spaceIdentities.moveMain(
		mainIdentity({repo, mainRoot: work, env: {}}),
	);
	const main = daos.spaceIdentities.get(MAIN_WORKTREE_KEY);
	expect(main.kind).toBe('identity');
	if (main.kind !== 'identity') return;
	expect(main.identity.repo).toBe(repo);
	expect(main.identity.worktreePath).toBe(work);
	expect(main.identity.tmux.agentSession).toBe(
		`agent-${tmuxSessionRepo(repo)}-main`,
	);
});

test('a directory in the work dir that is in no checkout belongs to its main space', async () => {
	const {work, workRepo, repos} = workdirFixture({
		repos: {api: {}},
		workdirConfig: listRepos,
	});
	expect(mainCheckoutHasConfig(work)).toBe(true);
	const {daos} = testState({repo: workRepo, mainRoot: () => work});
	await daos.spaceIdentities.moveMain(
		mainIdentity({repo: workRepo, mainRoot: work, env: {}}),
	);
	const at = (directory: string) => {
		const lookup = daos.spaceIdentities.atPath(directory);
		return lookup.kind === 'identity' ? lookup.identity.key : lookup.kind;
	};

	expect(at(work)).toBe(MAIN_WORKTREE_KEY);
	expect(at(path.join(work, '.lasagna'))).toBe(MAIN_WORKTREE_KEY);
	// A repo inside the work dir is its own repo's, not the work dir's.
	expect(at(repos['api']!.root)).toBe('unknown');
});

test('a pseudo-repo\u2019s hook status key is one path segment', () => {
	expect(hookStatusKey('@work', MAIN_WORKTREE_KEY)).toBe('@work-main');
});

test('a work dir\u2019s TUI runs in lasagna-wd-<workdir>, and a repo\u2019s where it always did', () => {
	expect(outerSessionName('@taptapsend')).toBe('lasagna-wd-taptapsend');
	expect(outerSessionName('@com.github.taptapsend')).toBe(
		'lasagna-wd-com_github_taptapsend',
	);
	expect(outerSessionName('appian-server')).toBe('lasagna-appian-server');
	expect(tuiSessionNames('@taptapsend')).toContain('lasagna-wd-taptapsend');
	expect(tuiSessionNames('appian-server')).toEqual(['lasagna-appian-server']);
});

test('a work dir\u2019s terminal tab is titled with its directory name', () => {
	const args = newOuterSessionArgs('@taptapsend', [], 'cmd');
	expect(args.slice(0, 3)).toEqual([
		'new-session',
		'-s',
		'lasagna-wd-taptapsend',
	]);
	expect(args.at(-1)).toBe('🍝 taptapsend');
	expect(newOuterSessionArgs('appian-server', [], 'cmd').at(-1)).toBe(
		'🍝 appian-server',
	);
});

test('a repo\u2019s main checkout is read in that repo, whatever directory the process runs in', async () => {
	const {repos} = workdirFixture({repos: {api: {}, web: {}}});
	const info = await getMainWorktreeInfo(repos['web']!.root);
	expect(info?.path).toBe(repos['web']!.root);
	expect(info?.branch).toBeTruthy();
	// The process's own checkout is still the default.
	const own = await getMainWorktreeInfo();
	expect(own?.path).not.toBe(repos['web']!.root);
});
