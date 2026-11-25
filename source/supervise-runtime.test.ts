import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {publishSnapshot, snapshotOf} from '../test/helpers/program-status.ts';
import {testState, writeClaudeStatus} from '../test/helpers/state.ts';
import {parseStatusPane} from './program-status-monitor.ts';
import {
	createAgyQuotaReader,
	defaultSuperviseDeps,
	sanitizedAgyEnv,
} from './supervise-runtime.ts';

test.serial(
	'a supervised wait ends early when a hook status or a native status changes',
	async t => {
		const state = testState(t);
		const deps = defaultSuperviseDeps(raw => raw, state.daos);
		const waited = async (ms: number, change?: () => Promise<void> | void) => {
			const started = performance.now();
			const waiting = deps.waitForStatusChange(ms);
			await delay(50);
			await change?.();
			await waiting;
			return performance.now() - started;
		};

		// Before any write: macOS can report a write after a later wait began.
		t.true((await waited(200)) >= 190);
		t.true(
			(await waited(3000, async () =>
				writeClaudeStatus(state, {
					sessionId: 'session',
					workspaceName: 'repo-STA-1',
					status: 'waiting_for_approval',
					lastUpdate: Date.now(),
				}),
			)) < 2000,
		);
		t.true(
			(await waited(3000, async () =>
				publishSnapshot(
					state,
					snapshotOf(
						{
							repo: 'repo',
							key: 'STA-1',
							pane: parseStatusPane('%1\t12\t0\t1\t12.owner', 'test-status')!,
						},
						[{state: 'working', id: ''}],
					),
				),
			)) < 2000,
		);
	},
);

test('createAgyQuotaReader strips PAPPARDELLE_* and TMUX*, forwards env/tilde/model, caches ok results, and leaves errors uncached', async t => {
	t.deepEqual(
		sanitizedAgyEnv({
			PATH: '/usr/bin',
			HOME: '/home/u',
			PAPPARDELLE_SPACE: 'STA-1',
			PAPPARDELLE_REPO: 'repo',
			TMUX: '/tmp/tmux-1000/default,1,0',
			TMUX_PANE: '%1',
			TMUX_TMPDIR: '/tmp',
		}),
		{PATH: '/usr/bin', HOME: '/home/u'},
	);

	let clock = new Date('2026-11-24T08:00:00Z').getTime();
	const calls: Array<{
		command: string;
		args: readonly string[];
		env: NodeJS.ProcessEnv;
	}> = [];
	let result: {kind: 'ok'; output: string} | {kind: 'error'} = {
		kind: 'ok',
		output: [
			'Gemini Models\tFive Hour Limit Remaining\t56%\t2026-11-24T09:10:11Z',
			'Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-11-24T09:10:11Z',
		].join('\n'),
	};
	const reader = createAgyQuotaReader({
		now: () => new Date(clock),
		env: {
			HOME: '/home/qa',
			PATH: '/bin',
			PAPPARDELLE_SPACE: 'STA-1',
			TMUX: 'x',
			DROP_ME: '1',
		},
		cacheTtlMs: 60_000,
		async run(command, args, opts) {
			calls.push({command, args, env: opts.env});
			return result;
		},
	});

	// Cache is shared per resolved launch/env, while model filters the parsed buckets.
	const gemini = await reader('~/bin/agy', {
		env: {FOO: 'bar'},
		unset: ['DROP_ME'],
		model: 'gemini-4-hydrogen-medium',
	});
	t.deepEqual(gemini, {kind: 'ok', limit: null});
	t.is(calls[0]!.command, '/home/qa/bin/agy');
	t.deepEqual(calls[0]!.args, ['-p', '/quota']);
	t.deepEqual(calls[0]!.env, {HOME: '/home/qa', PATH: '/bin', FOO: 'bar'});

	clock += 30_000;
	const claude = await reader('~/bin/agy', {
		env: {FOO: 'bar'},
		unset: ['DROP_ME'],
		model: 'claude-sonnet-4-6',
	});
	t.is(calls.length, 1);
	t.deepEqual(claude, {
		kind: 'ok',
		limit: {
			resetText: '2026-11-24T09:10:11Z',
			resetAt: new Date('2026-11-24T09:10:11Z'),
			passed: false,
		},
	});

	// Expired cache re-runs; errors return {kind: 'error'} and are NOT cached.
	clock += 40_000;
	result = {kind: 'error'};
	t.deepEqual(
		await reader('~/bin/agy', {env: {FOO: 'bar'}, unset: ['DROP_ME']}),
		{kind: 'error'},
	);
	t.is(calls.length, 2);

	result = {
		kind: 'ok',
		output:
			'Gemini Models\tFive Hour Limit Remaining\t0%\t2026-11-24T10:00:00Z\n',
	};
	const recovered = await reader('~/bin/agy', {
		env: {FOO: 'bar'},
		unset: ['DROP_ME'],
		model: 'gemini-4',
	});
	t.is(calls.length, 3);
	t.deepEqual(recovered, {
		kind: 'ok',
		limit: {
			resetText: '2026-11-24T10:00:00Z',
			resetAt: new Date('2026-11-24T10:00:00Z'),
			passed: false,
		},
	});
});
