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

test('createAgyQuotaReader strips PAPPARDELLE_* and TMUX* env, caches within TTL, and handles failures', async t => {
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
	let output: string | null =
		'Gemini Models\tFive Hour Limit Remaining\t0%\t2026-11-24T09:10:11Z\n';
	const reader = createAgyQuotaReader({
		now: () => new Date(clock),
		env: {PATH: '/bin', PAPPARDELLE_SPACE: 'STA-1', TMUX: 'x'},
		cacheTtlMs: 60_000,
		async run(command, args, opts) {
			calls.push({command, args, env: opts.env});
			return output;
		},
	});

	const first = await reader('/opt/agy');
	t.is(first?.resetText, '2026-11-24T09:10:11Z');
	t.deepEqual(calls[0]!.args, ['-p', '/quota']);
	t.deepEqual(calls[0]!.env, {PATH: '/bin'});

	// Cached hit within TTL does not re-run.
	clock += 30_000;
	await reader('/opt/agy');
	t.is(calls.length, 1);

	// Expired cache re-runs; failure returns null cleanly.
	clock += 40_000;
	output = null;
	t.is(await reader('/opt/agy'), null);
	t.is(calls.length, 2);
});
