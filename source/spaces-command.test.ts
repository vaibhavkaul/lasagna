import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import type {ClaudeSessionState} from './claude-status.ts';
import type {PappardelleConfig} from './config.ts';
import {
	parseStatusPane,
	type ProgramStatusSnapshot,
	type StatusPane,
} from './program-status-monitor.ts';
import {newSpaceIdentity} from './space-identity.ts';
import {
	formatSpaces,
	gatherSpaces,
	parseShortstat,
	worktreeGitSummary,
	type SpaceEntry,
	type SpacesDeps,
} from './spaces-command.ts';
import {
	claudeStatusFile,
	sqliteRun,
	testState,
	writeClaudeStatus,
	type TestState,
} from '../test/helpers/state.ts';

const REPO = 'test-repo';

const states = new Map<string, TestState>();

function tempHome(
	t: {teardown: (fn: () => void) => void},
	options: {sqlite?: boolean; clock?: () => Date} = {},
): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-spaces-'));
	t.teardown(() => {
		states.delete(home);
		fs.rmSync(home, {recursive: true, force: true});
	});
	states.set(
		home,
		testState(t, {
			repo: REPO,
			stateDir: path.join(home, '.pappardelle'),
			home,
			...options,
		}),
	);
	return home;
}

/** The stores a process run with this home directory would read. */
const stores = (home: string) => states.get(home)!.daos;

function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(
		file,
		typeof data === 'string' ? data : JSON.stringify(data),
	);
}

const repoState = (home: string, ...rest: string[]) =>
	path.join(home, '.pappardelle', 'repos', REPO, ...rest);

const statusKey = (key: string, repo = REPO) => `${repo}-${key}`;

/** A status as the hook reports it. */
async function writeStatus(
	home: string,
	workspaceName: string,
	state: Partial<ClaudeSessionState> &
		Pick<ClaudeSessionState, 'status' | 'lastUpdate'>,
): Promise<void> {
	await writeClaudeStatus(states.get(home)!, {
		sessionId: 'session',
		workspaceName,
		...state,
	});
}

function openSpaces(home: string, keys: string[]): void {
	writeJson(repoState(home, 'open-spaces.json'), keys);
}

async function gather(
	home: string,
	overrides: Partial<SpacesDeps> = {},
): Promise<SpaceEntry[]> {
	const report = await gatherSpaces({
		repoName: REPO,
		...stores(home),
		home,
		fetchTitles: async () => new Map(),
		gitSummary: async () => null,
		...overrides,
	});
	if ('error' in report) throw new Error(report.error);
	return report.spaces;
}

test('a repo with no open-spaces file reports the error', async t => {
	const home = tempHome(t);
	t.deepEqual(
		await gatherSpaces({
			repoName: REPO,
			...stores(home),
			home,
			fetchTitles: async () => new Map(),
			gitSummary: async () => null,
		}),
		{error: 'No open spaces file found', spaces: []},
	);
});

test('a registry that cannot be read reports the failure and its cause, not that there are no spaces', async t => {
	const home = tempHome(t);
	writeJson(repoState(home, 'open-spaces.json'), '{"not": "a list"}');
	const report = await gatherSpaces({
		repoName: REPO,
		...stores(home),
		home,
		fetchTitles: async () => new Map(),
		gitSummary: async () => null,
	});
	t.deepEqual(report.spaces, []);
	t.regex(
		(report as {error: string}).error,
		sqliteRun
			? /^Could not read the open spaces: .*open-spaces\.json could not be imported \(malformed\)$/
			: /^Could not read the open spaces: Invalid workspace registry$/,
	);
});

test('status is what the hook last recorded, however old', async t => {
	const home = tempHome(t);
	const now = Date.now();
	openSpaces(home, ['STA-100', 'STA-200']);
	await writeStatus(home, statusKey('STA-100'), {
		status: 'processing',
		currentTool: 'Bash',
		// Older than the TUI's active-status timeout; the board still sees it.
		lastUpdate: now - 3 * 60 * 60_000,
		sessionId: 'sess-abc',
	});
	const spaces = await gather(home, {now});
	const byName = new Map(spaces.map(space => [space.name, space]));
	t.like(byName.get('STA-100'), {
		status: 'processing',
		currentTool: 'Bash',
		sessionId: 'sess-abc',
		minutesAgo: 180,
	});
	t.is(byName.get('STA-200')?.status, 'no_status');
});

test('a status file that cannot be read is unknown, not missing', async t => {
	const home = tempHome(t, {sqlite: false});
	openSpaces(home, ['STA-700']);
	writeJson(
		claudeStatusFile(states.get(home)!, statusKey('STA-700')),
		'not json{{{',
	);
	const [space] = await gather(home);
	t.is(space?.status, 'unknown');
});

test('another repo with a space of the same key does not supply its status', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-1']);
	await writeStatus(home, statusKey('STA-1', 'other-repo'), {
		status: 'waiting_for_approval',
		lastUpdate: Date.now(),
	});
	const before = await gather(home);
	t.is(before[0]?.status, 'no_status');
	await writeStatus(home, statusKey('STA-1'), {
		status: 'ended',
		lastUpdate: Date.now(),
	});
	const after = await gather(home);
	t.is(after[0]?.status, 'ended');
});

test('metadata, rail state and the newest PR link are included', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-350']);
	const meta = {
		created_by_pappardelle: true,
		created_at: '2026-04-21T04:00:00Z',
	};
	writeJson(repoState(home, 'issue-meta', 'STA-350.json'), meta);
	const link = (number: number) => ({
		host: 'example.com',
		project: 'user/repo',
		localBranch: `branch-${number}`,
		remoteBranch: 'published',
		url: `https://example.com/pr/${number}`,
		number,
	});
	writeJson(repoState(home, 'space-state', 'STA-350.json'), {
		pipeline: 'failing',
		unresolvedCommentCount: 4,
		prNumber: 777,
		recap: {customTitle: 'refactor auth'},
		updatedAt: '2026-04-21T05:00:00.000Z',
		prLinks: [link(1), link(2)],
	});
	const [space] = await gather(home);
	t.like(space, {
		meta,
		pipeline: 'failing',
		unresolvedCommentCount: 4,
		prNumber: 777,
		recap: {customTitle: 'refactor auth'},
		spaceStateUpdatedAt: '2026-04-21T05:00:00.000Z',
		prUrl: 'https://example.com/pr/2',
	});
});

test('rail fields are absent without a readable space-state file', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-360', 'STA-370']);
	writeJson(repoState(home, 'space-state', 'STA-370.json'), 'not json{{{');
	for (const space of await gather(home)) {
		t.false('pipeline' in space);
		t.false('recap' in space);
		t.is(space.prUrl, null);
	}
});

// The board reads this report. With the database a space's state is only
// rewritten when it changes, so `spaceStateUpdatedAt` is the one field that
// may differ: the time of the last change, not of the last poll.
test('the report is the same from files and from the database for the same history', async t => {
	const report = async (sqlite: boolean) => {
		let now = '2026-04-21T05:00:00.000Z';
		const home = tempHome(t, {sqlite, clock: () => new Date(now)});
		const daos = stores(home);
		openSpaces(home, ['NEW-1', 'OLD-2', 'IDLE-3']);
		await daos.issueMeta.markCreated('NEW-1');
		await daos.spaceState.write('NEW-1', {profile: 'dev'});
		await daos.spaceState.write('IDLE-3', {profile: 'dev'});
		const poll = async () =>
			daos.spaceState.writeMany([
				{
					key: 'NEW-1',
					patch: {
						pipeline: 'failing',
						unresolvedCommentCount: 4,
						prNumber: 777,
						hasConflict: true,
						recap: {customTitle: 'refactor auth', lastPrompt: 'go on'},
					},
				},
				{
					key: 'OLD-2',
					patch: {
						pipeline: null,
						unresolvedCommentCount: 0,
						prNumber: undefined,
						hasConflict: false,
					},
				},
			]);
		await poll();
		await daos.spaceState.addPrLink('NEW-1', {
			host: 'github.com',
			project: 'user/repo',
			localBranch: 'NEW-1',
			remoteBranch: 'published',
			url: 'https://github.com/user/repo/pull/777',
			number: 777,
		});
		now = '2026-04-21T06:00:00.000Z';
		await poll();
		const spaces = await gather(home, {now: 0});
		return {
			updatedAt: Object.fromEntries(
				spaces.map(space => [space.name, space.spaceStateUpdatedAt]),
			),
			rest: spaces.map(({spaceStateUpdatedAt, ...rest}) => rest),
		};
	};

	const files = await report(false);
	const database = await report(true);
	t.deepEqual(database.rest, files.rest);
	t.like(
		files.rest.find(space => space.name === 'NEW-1'),
		{
			meta: {created_by_pappardelle: true, created_at: '2026-04-21T05:00:00Z'},
			pipeline: 'failing',
			prNumber: 777,
			prUrl: 'https://github.com/user/repo/pull/777',
		},
	);
	const polledWithoutPr = files.rest.find(space => space.name === 'OLD-2')!;
	t.is(polledWithoutPr.pipeline, null);
	t.false('prNumber' in polledWithoutPr);
	t.false('pipeline' in files.rest.find(space => space.name === 'IDLE-3')!);
	t.deepEqual(files.updatedAt, {
		'NEW-1': '2026-04-21T06:00:00.000Z',
		'OLD-2': '2026-04-21T06:00:00.000Z',
		'IDLE-3': '2026-04-21T05:00:00.000Z',
	});
	t.deepEqual(database.updatedAt, {
		'NEW-1': '2026-04-21T05:00:00.000Z',
		'OLD-2': '2026-04-21T05:00:00.000Z',
		'IDLE-3': '2026-04-21T05:00:00.000Z',
	});
});

test('a session belongs to the space whose stored worktree holds it', async t => {
	const home = tempHome(t, {sqlite: true});
	const worktree = path.join(home, 'checkouts', 'login');
	await stores(home).spaceIdentities.record({
		repo: REPO,
		key: 'STA-410',
		worktreePath: worktree,
		tmux: {
			socket: 'pappardelle_inner',
			agentSession: `agent-${REPO}-STA-410`,
			companionSession: `companion-${REPO}-STA-410`,
		},
	});
	openSpaces(home, ['STA-410']);
	writeJson(path.join(home, '.claude', 'sessions', 'login.json'), {
		pid: 33_333,
		cwd: `${worktree}/src`,
	});
	const [space] = await gather(home);
	t.is(space!.pid, 33_333);
});

test('sessions match on the full worktree prefix and the newest wins', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-400', 'STA-500']);
	const sessions = path.join(home, '.claude', 'sessions');
	writeJson(path.join(sessions, 'stale.json'), {
		pid: 11_111,
		cwd: `${home}/.worktrees/${REPO}/STA-400`,
		startedAt: '2026-01-01T00:00:00Z',
	});
	writeJson(path.join(sessions, 'fresh.json'), {
		pid: 22_222,
		cwd: `${home}/.worktrees/${REPO}/STA-400/sub`,
		startedAt: '2026-04-01T00:00:00Z',
	});
	writeJson(path.join(sessions, 'other-repo.json'), {
		pid: 99_999,
		cwd: `${home}/.worktrees/${REPO}-api/STA-500`,
	});
	const spaces = await gather(home);
	const byName = new Map(spaces.map(s => [s.name, s]));
	t.is(byName.get('STA-400')?.pid, 22_222);
	t.is(byName.get('STA-500')?.pid, undefined);
});

test('the newest top-level jsonl is the conversation log', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-800']);
	const encoded = `${home}/.worktrees/${REPO}/STA-800`
		.replaceAll('/', '-')
		.replaceAll('.', '-');
	const dir = path.join(home, '.claude', 'projects', encoded);
	writeJson(path.join(dir, 'old.jsonl'), '{}');
	writeJson(path.join(dir, 'new.jsonl'), '{}');
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(path.join(dir, 'old.jsonl'), past, past);
	const [space] = await gather(home);
	t.is(space!.conversationLog, path.join(dir, 'new.jsonl'));
	t.is(typeof space!.logMinutesAgo, 'number');
});

test('spaces sort by last update and carry tmux session names', async t => {
	const home = tempHome(t);
	const now = Date.now();
	openSpaces(home, ['STA-OLD', 'STA-NEW', 'a.b_c']);
	const status = async (key: string, ago: number) =>
		writeStatus(home, statusKey(key), {
			status: 'ended',
			lastUpdate: now - ago,
		});
	await status('STA-OLD', 60_000);
	await status('STA-NEW', 0);
	const spaces = await gather(home, {now});
	t.deepEqual(
		spaces.map(s => s.name),
		['STA-NEW', 'STA-OLD', 'a.b_c'],
	);
	t.is(spaces[2]!.tmuxSession, `agent-${REPO}-a_b__c`);
});

test('titles come from the tracker, and null when it fails or is slow', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-1']);
	const [found] = await gather(home, {
		fetchTitles: async () => new Map([['STA-1', 'Fix auth']]),
	});
	t.is(found!.title, 'Fix auth');
	const [failed] = await gather(home, {
		async fetchTitles() {
			throw new Error('offline');
		},
	});
	t.is(failed!.title, null);
	const [slow] = await gather(home, {
		titleTimeoutMs: 20,
		fetchTitles: async () =>
			new Promise(resolve => {
				setTimeout(() => {
					resolve(new Map([['STA-1', 'late']]));
				}, 500);
			}),
	});
	t.is(slow!.title, null);
});

function git(cwd: string, ...args: string[]): void {
	execFileSync('git', args, {
		cwd,
		stdio: 'ignore',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 't',
			GIT_AUTHOR_EMAIL: 't@t',
			GIT_COMMITTER_NAME: 't',
			GIT_COMMITTER_EMAIL: 't@t',
		},
	});
}

test('the git summary counts commits ahead of main and the diff since the branch point', async t => {
	const home = tempHome(t);
	const repo = path.join(home, 'repo');
	fs.mkdirSync(repo);
	git(repo, 'init', '-q', '-b', 'main');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-qm', 'base');
	git(repo, 'checkout', '-qb', 'work');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
	git(repo, 'commit', '-qam', 'two');
	fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-qm', 'b');
	// Upstream moves on after the branch point; it must not count.
	git(repo, 'checkout', '-q', 'main');
	fs.writeFileSync(path.join(repo, 'c.txt'), 'upstream\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-qm', 'upstream');
	git(repo, 'checkout', '-q', 'work');
	fs.writeFileSync(path.join(repo, 'new.txt'), 'not added\n');
	t.deepEqual(await worktreeGitSummary(repo), {
		base: 'main',
		ahead: 2,
		filesChanged: 2,
		insertions: 2,
		deletions: 0,
		untracked: 1,
	});
});

test('parseShortstat reads each count, singular or plural, and missing ones as 0', t => {
	t.deepEqual(
		parseShortstat(' 3 files changed, 120 insertions(+), 45 deletions(-)'),
		{filesChanged: 3, insertions: 120, deletions: 45},
	);
	t.deepEqual(parseShortstat(' 1 file changed, 1 deletion(-)'), {
		filesChanged: 1,
		insertions: 0,
		deletions: 1,
	});
	t.deepEqual(parseShortstat(''), {
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
	});
});

test('text output puts one space per line with its flags', t => {
	const text = formatSpaces({
		totalSpaces: 1,
		timestamp: 0,
		spaces: [
			{
				name: 'STA-1',
				status: 'waiting_for_input',
				minutesAgo: 12,
				tmuxSession: 'claude-r-STA-1',
				title: 'Fix auth',
				prUrl: null,
				git: {
					base: 'main',
					ahead: 3,
					filesChanged: 1,
					insertions: 1,
					deletions: 0,
					untracked: 2,
				},
				pipeline: 'failing',
				unresolvedCommentCount: 2,
			},
		],
	});
	t.is(
		text,
		'STA-1  waiting_for_input  12m ago  Fix auth  +3 commits  +2 new files  [pipeline red]  [2 unresolved]',
	);
});

test('an agent still reporting under the bare status name is read until it reports under the qualified one', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-1']);
	await writeStatus(home, 'STA-1', {
		status: 'processing',
		lastUpdate: Date.now(),
	});
	const before = await gather(home);
	t.is(before[0]?.status, 'processing');
	await writeStatus(home, statusKey('STA-1'), {
		status: 'ended',
		lastUpdate: Date.now(),
	});
	const after = await gather(home);
	t.is(after[0]?.status, 'ended');
});

function makeStatusPane(id: string, pid: string, marker: string): StatusPane {
	return parseStatusPane(
		`${id}\t${pid}\t0\t1\t${marker}`,
		'pappardelle_inner',
	)!;
}

function makeSnapshot(options: {
	key: string;
	pane: StatusPane;
	info: ProgramStatusSnapshot['info'];
	updatedAt: number;
	authoritative?: boolean;
}): ProgramStatusSnapshot {
	return {
		version: 1,
		repo: REPO,
		key: options.key,
		pane: options.pane,
		authoritative: options.authoritative ?? true,
		exited: false,
		updatedAt: options.updatedAt,
		records: [],
		info: options.info,
	};
}

test('OSC program status reports Claude-vocabulary status and minutesAgo for agy and Codex spaces without Claude hooks', async t => {
	const home = tempHome(t);
	const now = 1_700_000_600_000;
	const daos = stores(home);
	const keys = [
		'AGY-IDLE',
		'AGY-DONE',
		'CODEX-WORK',
		'CODEX-TOOL',
		'AGY-PERM',
		'AGY-Q',
	];
	openSpaces(home, keys);

	const panes = new Map<string, StatusPane>();
	const snapshots = new Map<string, ProgramStatusSnapshot>();
	const addOsc = async (
		key: string,
		info: ProgramStatusSnapshot['info'],
		ageMinutes: number,
		pid: string,
	) => {
		const identity = newSpaceIdentity({
			repo: REPO,
			key,
			worktreePath: path.join(home, '.worktrees', REPO, key),
			socket: 'pappardelle_inner',
		});
		await daos.spaceIdentities.record(identity);
		const pane = makeStatusPane(`%${pid}`, pid, `${pid}.m`);
		panes.set(identity.tmux.agentSession, pane);
		snapshots.set(
			key,
			makeSnapshot({key, pane, info, updatedAt: now - ageMinutes * 60_000}),
		);
	};

	await addOsc('AGY-IDLE', {status: 'idle', app: 'antigravity'}, 2, '10');
	await addOsc('AGY-DONE', {status: 'done', app: 'antigravity'}, 5, '11');
	await addOsc('CODEX-WORK', {status: 'working', app: 'codex'}, 0.5, '12');
	await addOsc(
		'CODEX-TOOL',
		{status: 'working', tool: 'Bash', app: 'codex'},
		0.2,
		'15',
	);
	await addOsc(
		'AGY-PERM',
		{status: 'blocked', kind: 'permission', app: 'antigravity'},
		1,
		'13',
	);
	await addOsc(
		'AGY-Q',
		{status: 'blocked', kind: 'question', app: 'antigravity'},
		3,
		'14',
	);

	const spaces = await gather(home, {
		now,
		listStatusPanes: async () =>
			new Map(
				[...panes].map(([session, pane]) => [session, {pinned: pane.id, pane}]),
			),
		programStatus: {
			async read(key, pane) {
				const snap = snapshots.get(key);
				return snap && snap.pane.generation === pane.generation ? snap : null;
			},
		},
	});
	const byName = new Map(spaces.map(s => [s.name, s]));
	t.like(byName.get('AGY-IDLE'), {status: 'waiting_for_input', minutesAgo: 2});
	t.like(byName.get('AGY-DONE'), {status: 'waiting_for_input', minutesAgo: 5});
	t.like(byName.get('CODEX-WORK'), {status: 'processing', minutesAgo: 0.5});
	t.like(byName.get('CODEX-TOOL'), {
		status: 'running_tool',
		currentTool: 'Bash',
		minutesAgo: 0.2,
	});
	t.like(byName.get('AGY-PERM'), {
		status: 'waiting_for_approval',
		minutesAgo: 1,
	});
	t.like(byName.get('AGY-Q'), {status: 'waiting_for_approval', minutesAgo: 3});
	t.deepEqual(
		spaces.map(s => s.name),
		['CODEX-TOOL', 'CODEX-WORK', 'AGY-PERM', 'AGY-IDLE', 'AGY-Q', 'AGY-DONE'],
	);
});

test('non-authoritative OSC snapshots fall back to Claude hook or no_status', async t => {
	const home = tempHome(t);
	const now = 1_700_000_000_000;
	const daos = stores(home);
	openSpaces(home, ['STA-CLAUDE', 'STA-NEW']);
	for (const key of ['STA-CLAUDE', 'STA-NEW']) {
		await daos.spaceIdentities.record(
			newSpaceIdentity({
				repo: REPO,
				key,
				worktreePath: path.join(home, '.worktrees', REPO, key),
				socket: 'pappardelle_inner',
			}),
		);
	}

	await writeStatus(home, statusKey('STA-CLAUDE'), {
		status: 'running_tool',
		currentTool: 'Edit',
		lastUpdate: now - 60_000,
	});
	const paneClaude = makeStatusPane('%1', '1', '1.m');
	const paneNew = makeStatusPane('%2', '2', '2.m');
	const spaces = await gather(home, {
		now,
		listStatusPanes: async () =>
			new Map([
				[`agent-${REPO}-STA-CLAUDE`, {pinned: '%1', pane: paneClaude}],
				[`agent-${REPO}-STA-NEW`, {pinned: '%2', pane: paneNew}],
			]),
		programStatus: {
			read: async (key, pane) =>
				makeSnapshot({
					key,
					pane,
					info: {status: 'unknown'},
					updatedAt: now,
					authoritative: false,
				}),
		},
	});
	const byName = new Map(spaces.map(s => [s.name, s]));
	t.like(byName.get('STA-CLAUDE'), {
		status: 'running_tool',
		currentTool: 'Edit',
	});
	t.is(byName.get('STA-NEW')?.status, 'no_status');
});

test('agy and Codex spaces ignore leftover Claude hook status and Claude session files', async t => {
	const home = tempHome(t);
	const now = 1_700_000_000_000;
	const daos = stores(home);
	openSpaces(home, ['AGY-SWITCHED', 'CODEX-SWITCHED']);
	for (const key of ['AGY-SWITCHED', 'CODEX-SWITCHED']) {
		const worktree = path.join(home, '.worktrees', REPO, key);
		await daos.spaceIdentities.record(
			newSpaceIdentity({
				repo: REPO,
				key,
				worktreePath: worktree,
				socket: 'pappardelle_inner',
			}),
		);
		await writeStatus(home, statusKey(key), {
			status: 'running_tool',
			currentTool: 'Bash',
			sessionId: `stale-claude-${key}`,
			lastUpdate: now - 30_000,
		});
		writeJson(path.join(home, '.claude', 'sessions', `${key}.json`), {
			pid: 99_999,
			cwd: worktree,
		});
		const encoded = worktree.replaceAll('/', '-').replaceAll('.', '-');
		writeJson(
			path.join(home, '.claude', 'projects', encoded, 'stale.jsonl'),
			'{}',
		);
	}

	await daos.spaceState.write('AGY-SWITCHED', {
		agentProfile: {name: 'agy', isClaude: false},
	});
	await daos.spaceState.write('CODEX-SWITCHED', {
		agentProfile: {name: 'codex', isClaude: false},
	});

	const spaces = await gather(home, {now});
	for (const space of spaces) {
		t.is(space.status, 'no_status');
		t.is(space.currentTool, undefined);
		t.is(space.lastUpdate, undefined);
		t.is(space.sessionId, undefined);
		t.is(space.pid, undefined);
		t.is(space.worktreePath, undefined);
		t.is(space.conversationLog, undefined);
	}
});

test('agy spaces expose their transcript as conversationLog and never fall back to stale Claude logs', async t => {
	const home = tempHome(t);
	const now = 1_700_000_000_000;
	const daos = stores(home);
	openSpaces(home, ['AGY-WITH-LOG', 'AGY-NO-LOG']);
	for (const key of ['AGY-WITH-LOG', 'AGY-NO-LOG']) {
		const worktree = path.join(home, '.worktrees', REPO, key);
		await daos.spaceIdentities.record(
			newSpaceIdentity({
				repo: REPO,
				key,
				worktreePath: worktree,
				socket: 'pappardelle_inner',
			}),
		);
		// Simulate a stale Claude transcript from before switching to agy.
		const encoded = worktree.replaceAll('/', '-').replaceAll('.', '-');
		writeJson(
			path.join(home, '.claude', 'projects', encoded, 'old.jsonl'),
			'{}',
		);
	}

	await daos.spaceState.write('AGY-WITH-LOG', {
		agentProfile: {name: 'argon', isClaude: false},
	});
	await daos.spaceState.write('AGY-NO-LOG', {
		agentProfile: {name: 'agy', isClaude: false},
	});
	writeJson(daos.agentSessions.file('AGY-WITH-LOG'), {
		argon: {session_id: 'conv-123', pid: 42, started: null},
	});
	const agyLog = path.join(
		home,
		'.gemini',
		'antigravity-cli',
		'brain',
		'conv-123',
		'.system_generated',
		'logs',
		'transcript.jsonl',
	);
	fs.mkdirSync(path.dirname(agyLog), {recursive: true});
	fs.writeFileSync(agyLog, '{"type":"USER_INPUT","content":"hi"}\n');
	const config: PappardelleConfig = {
		version: 1,
		team_prefix: 'STA',
		agent_profiles: {argon: {command: 'agy'}},
		profiles: {dev: {display_name: 'Dev'}},
	};

	const spaces = await gather(home, {now, config});
	const byName = new Map(spaces.map(s => [s.name, s]));
	t.is(byName.get('AGY-WITH-LOG')?.conversationLog, agyLog);
	t.is(typeof byName.get('AGY-WITH-LOG')?.logMinutesAgo, 'number');
	t.is(byName.get('AGY-NO-LOG')?.conversationLog, undefined);
});
