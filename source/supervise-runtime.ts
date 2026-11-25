// The real dependencies of the supervision verbs: this machine's tmux, clock,
// timers and environment. Read once here, so the verbs stay testable.

import {execFile, spawnSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {homedir, tmpdir, userInfo} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {parseAgyQuota, type UsageLimit} from './agent-screen.ts';
import type {AgentStateReport} from './agent-state.ts';
import {classifyCommand, defaultClassifierRun} from './approve-classifier.ts';
import type {ApprovalPolicy} from './approve-policy.ts';
import {isAgyCommand, unwrappedCommandWord} from './companion-rules.ts';
import {newHoldId} from './holds.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {spaceStatusKey} from './claude-status.ts';
import {
	getAgentProfile,
	getMainRepoRoot,
	getNamedAgentProfile,
	getRepoName,
	readConfig,
} from './config.ts';
import {selfLaunchArgs} from './runtime.ts';
import {rearmMissingTimers, type ScheduleDao} from './schedule.ts';
import {
	launchdBackend,
	systemdBackend,
	type TimerBackend,
	type TimerContext,
} from './schedule-timers.ts';
import type {SpaceStateDao} from './space-state.ts';
import type {StateDaos} from './state-daos.ts';
import {defaultReadStdin, type SuperviseDeps} from './supervise-command.ts';
import {callerFromEnv, recordSupervision} from './supervise-log.ts';
import {createLogger} from './logger.ts';
import {
	getMainWorktreeInfo,
	getWorktreePath,
	spaceSessionNames,
	resolveInnerSessionTargetSync,
	sendKeysToSpaceAgent,
	type SendToSpaceAgentResult,
	sendToSpaceAgent,
	supervisedInnerTmuxRunner,
	supervisedServerTmuxRunner,
} from './tmux.ts';

const log = createLogger('supervise');
const execFileAsync = promisify(execFile);

export const AGY_QUOTA_CACHE_MS = 60_000;
export const AGY_QUOTA_TIMEOUT_MS = 10_000;

/**
 * Strip `PAPPARDELLE_*` and `TMUX*` so `agy -p /quota` does not trigger
 * session-recording hooks or interact with the caller's tmux session.
 */
export function sanitizedAgyEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(
			([name]) => !name.startsWith('PAPPARDELLE_') && !name.startsWith('TMUX'),
		),
	);
}

export type QuotaCommandRunner = (
	command: string,
	args: readonly string[],
	options: {env: NodeJS.ProcessEnv; timeoutMs: number},
) => Promise<string | null>;

async function defaultQuotaRunner(
	command: string,
	args: readonly string[],
	{env, timeoutMs}: {env: NodeJS.ProcessEnv; timeoutMs: number},
): Promise<string | null> {
	try {
		const {stdout} = await execFileAsync(command, [...args], {
			env,
			timeout: timeoutMs,
			encoding: 'utf8',
		});
		return stdout;
	} catch {
		return null;
	}
}

export function createAgyQuotaReader({
	run = defaultQuotaRunner,
	now,
	env = process.env,
	cacheTtlMs = AGY_QUOTA_CACHE_MS,
	timeoutMs = AGY_QUOTA_TIMEOUT_MS,
}: {
	run?: QuotaCommandRunner;
	now: () => Date;
	env?: NodeJS.ProcessEnv;
	cacheTtlMs?: number;
	timeoutMs?: number;
}): (command: string) => Promise<UsageLimit | null> {
	const cache = new Map<string, {output: string | null; at: number}>();
	const inflight = new Map<string, Promise<string | null>>();

	const fetchOutput = async (command: string): Promise<string | null> => {
		const cached = cache.get(command);
		const currentMs = now().getTime();
		if (cached && currentMs - cached.at < cacheTtlMs) return cached.output;
		let pending = inflight.get(command);
		if (!pending) {
			pending = run(command, ['-p', '/quota'], {
				env: sanitizedAgyEnv(env),
				timeoutMs,
			})
				.then(output => {
					cache.set(command, {output, at: now().getTime()});
					return output;
				})
				.finally(() => {
					inflight.delete(command);
				});
			inflight.set(command, pending);
		}

		return pending;
	};

	return async (command: string) => {
		const output = await fetchOutput(command);
		return output === null ? null : parseAgyQuota(output, now());
	};
}

function agyCommandForSpace(
	key: string,
	report: AgentStateReport,
	spaceState: Pick<SpaceStateDao, 'read'>,
): string | null {
	if (report.app && report.app !== 'antigravity') return null;
	const state = spaceState.read(key);
	const load = readConfig();
	if (load.kind === 'valid') {
		const profile = state?.agentProfile?.name
			? getNamedAgentProfile(load.config, state.agentProfile.name)
			: getAgentProfile(load.config, state?.issueTitle, state?.profile);
		if (isAgyCommand(profile.command)) {
			return unwrappedCommandWord(profile.command);
		}
	}

	return report.app === 'antigravity' ? 'agy' : null;
}

// Timer services start with a bare environment; these decide which tmux
// server, status files, state database and status daemon `pappardelle`
// reaches when one fires.
const PASSED_TO_TIMERS = [
	'PATH',
	'TMUX_TMPDIR',
	'PAPPARDELLE_TMUX_SOCKET',
	'PAPPARDELLE_STATUS_DIR',
	'PAPPARDELLE_PROGRAM_STATUS_DIR',
	'PAPPARDELLE_SQLITE_STATE',
	'PAPPARDELLE_STATE_DB',
	'PAPPARDELLE_STATUS_SOCKET',
];

function timerBackend(): TimerBackend {
	const env = Object.fromEntries(
		PASSED_TO_TIMERS.flatMap(name => {
			const value = process.env[name];
			return value ? [[name, value]] : [];
		}),
	);
	const context: TimerContext = {
		repo: getRepoName(),
		cwd: getMainRepoRoot(),
		launch: [process.execPath, ...selfLaunchArgs()],
		env,
		run(command, args) {
			const result = spawnSync(command, args, {encoding: 'utf8'});
			return {
				status: result.status,
				stderr: result.stderr ?? result.error?.message ?? '',
			};
		},
	};
	if (process.platform === 'linux') return systemdBackend(context);
	if (process.platform === 'darwin') {
		return launchdBackend({...context, home: homedir(), uid: userInfo().uid});
	}

	throw new Error(`Scheduling isn't supported on ${process.platform}`);
}

function agentCwd(key: string): string | null {
	const session = spaceSessionNames(key)?.agent;
	const target =
		session &&
		resolveInnerSessionTargetSync(session, supervisedInnerTmuxRunner);
	if (!target) return null;
	const result = supervisedInnerTmuxRunner([
		'display-message',
		'-p',
		'-t',
		target,
		'#{pane_current_path}',
	]);
	return result.status === 0 ? result.stdout.trim() || null : null;
}

const unique = (paths: string[]) => [...new Set(paths)];

function tempRoots(): string[] {
	return unique(['/tmp/', '/private/tmp/', `${tmpdir()}/`]);
}

function defaultBranch(worktree: string): string | null {
	const result = spawnSync(
		'git',
		['-C', worktree, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
		{encoding: 'utf8'},
	);
	return result.status === 0
		? result.stdout.trim().replace(/^origin\//, '') || null
		: null;
}

const worktreeOf = (key: string) =>
	key === MAIN_WORKTREE_KEY ? null : getWorktreePath(key);

/** What is inside a space on this machine. */
function approvalPolicy(key: string): ApprovalPolicy {
	const worktree = worktreeOf(key);
	const claude = `claude-${userInfo().uid}`;
	const tmuxTmpdir = process.env['TMUX_TMPDIR'];
	return {
		worktree,
		roots: tempRoots(),
		// The desktop's and ssh-agent's sockets live in /tmp too.
		reserved: unique([
			'/tmp/.X11-unix',
			'/tmp/.ICE-unix',
			'/tmp/ssh-',
			'/private/tmp/com.apple.launchd.',
			'/tmp/tmux-',
			'/private/tmp/tmux-',
			path.join(tmpdir(), 'tmux-'),
			...(tmuxTmpdir ? [path.join(tmuxTmpdir, 'tmux-')] : []),
		]),
		shared: unique([
			`/tmp/${claude}`,
			`/private/tmp/${claude}`,
			path.join(tmpdir(), claude),
		]),
		scratchpad: (worktree ?? getMainRepoRoot()).replaceAll(/[^\w-]/g, '-'),
		defaultBranch: worktree ? defaultBranch(worktree) : null,
		realpath: target => realpathSync(target),
	};
}

/** Run as the TUI starts, so wake-ups lost to a reboot come back. */
export async function rearmSchedules(schedules: ScheduleDao): Promise<void> {
	try {
		const rearmed = await rearmMissingTimers(
			schedules,
			timerBackend(),
			new Date(),
		);
		for (const job of rearmed) {
			recordSupervision(
				getRepoName(),
				'tui',
				{
					action: 'schedule',
					key: job.key,
					detail: `re-armed ${job.id}, its timer was gone`,
				},
				new Date(),
			);
		}
	} catch (error) {
		log.warn('Could not re-arm scheduled wake-ups', error as Error);
	}
}

const keyOutcome = (result: SendToSpaceAgentResult) =>
	result === 'sent' || result === 'no-session' ? result : 'failed';

export function defaultSuperviseDeps(
	resolveKey: (raw: string) => string,
	{
		claudeStatus,
		schedules,
		holds,
		programStatus,
		spaceIdentities,
		spaceState,
	}: Pick<
		StateDaos,
		| 'claudeStatus'
		| 'schedules'
		| 'holds'
		| 'programStatus'
		| 'spaceIdentities'
		| 'spaceState'
	>,
): SuperviseDeps {
	const now = () => new Date();
	const quotaReader = createAgyQuotaReader({now});
	return {
		repo: getRepoName,
		identities: spaceIdentities,
		resolveKey,
		hookKey: async key =>
			spaceStatusKey(claudeStatus, getRepoName(), key, async () => {
				const main = await getMainWorktreeInfo();
				return main?.branch;
			}),
		readHook: async hookKey => claudeStatus.read(hookKey),
		readHookState: async hookKey => claudeStatus.readState(hookKey),
		readSnapshot: async (key, pane) => programStatus.read(key, pane),
		async readAgyQuota(key, report) {
			const command = agyCommandForSpace(key, report, spaceState);
			return command ? quotaReader(command) : null;
		},
		runner: supervisedInnerTmuxRunner,
		serverRunner: supervisedServerTmuxRunner,
		now,
		async sleep(ms) {
			await new Promise(resolve => {
				setTimeout(resolve, ms);
			});
		},
		async waitForStatusChange(ms) {
			await Promise.race([
				claudeStatus.waitForChange(ms),
				programStatus.waitForChange(ms),
			]);
		},
		async send(key, text) {
			return sendToSpaceAgent(key, text);
		},
		sendKeys(key, keys) {
			const result = sendKeysToSpaceAgent(key, keys, {
				runner: supervisedInnerTmuxRunner,
				answering: true,
			});
			return keyOutcome(result);
		},
		typeText(key, text) {
			const result = sendKeysToSpaceAgent(key, [text], {
				runner: supervisedInnerTmuxRunner,
				answering: true,
				literal: true,
			});
			return keyOutcome(result);
		},
		async classify(key, request) {
			return classifyCommand(
				{
					...request,
					worktree: worktreeOf(key),
					cwd: request.cwd ?? agentCwd(key),
					tempRoots: tempRoots(),
				},
				defaultClassifierRun,
			);
		},
		policy: approvalPolicy,
		store: () => schedules,
		holds: () => holds,
		newHoldId,
		timers: timerBackend,
		caller: callerFromEnv(process.env),
		readStdin: defaultReadStdin,
		out(text) {
			console.log(text);
		},
		err(text) {
			console.error(text);
		},
	};
}
