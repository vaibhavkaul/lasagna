// What ticket-ops.ts runs on in a real process, where it decides something:
// whether a plain space's sessions have ended, which is what lets its
// worktree move.
import {test, expect} from 'bun:test';
import {newSpaceIdentity} from './space-identity.ts';
import {endIdentitySessions} from './ticket-runtime.ts';
import type {OuterTmuxRunner} from './tmux.ts';

const identity = newSpaceIdentity({
	repo: 'api',
	key: 'B2B-1',
	worktreePath: '/home/me/.lasagna/worktrees/api/B2B-1',
	socket: 'lasagna_inner',
});

/** A tmux that lists `sessions`, or answers `list-sessions` with `failure`. */
function tmux(
	sessions: string[],
	failure?: Partial<ReturnType<OuterTmuxRunner>>,
) {
	const killed: string[] = [];
	const run: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions')
			return failure
				? {status: 1, stdout: '', stderr: '', ...failure}
				: {status: 0, stdout: `${sessions.join('\n')}\n`, stderr: ''};
		killed.push(args.at(-1)!);
		return {status: 0, stdout: '', stderr: ''};
	};

	return {run, killed};
}

test("ending a space's sessions ends its agent's, its companion's and the companion's splits, and no other space's", () => {
	const {run, killed} = tmux([
		'agent-api-B2B-1',
		'claude-api-B2B-1',
		'companion-api-B2B-1',
		'companion-api-B2B-1~web',
		'agent-api-B2B-12',
		'companion-web-B2B-1',
	]);
	expect(endIdentitySessions(identity, run)).toBe(true);
	expect(killed).toEqual([
		'=agent-api-B2B-1:',
		'=claude-api-B2B-1:',
		'=companion-api-B2B-1:',
		'=companion-api-B2B-1~web:',
	]);
});

test('no tmux server means no session to end', () => {
	for (const stderr of [
		'no server running on /tmp/tmux-501/lasagna_inner\n',
		'error connecting to /tmp/tmux-501/lasagna_inner (No such file or directory)\n',
	])
		expect(endIdentitySessions(identity, tmux([], {stderr}).run)).toBe(true);
});

test('a tmux that did not answer leaves the sessions counted as running, so nothing moves under them', () => {
	// It could not be run, it timed out, or it failed for a reason of its own.
	for (const failure of [
		{error: new Error('spawnSync tmux ETIMEDOUT'), status: null},
		{error: new Error('spawnSync tmux ENOENT'), status: null},
		{status: 1, stderr: 'lost server\n'},
		{status: 1, stderr: ''},
	]) {
		const {run, killed} = tmux(['agent-api-B2B-1'], failure);
		expect(endIdentitySessions(identity, run)).toBe(false);
		expect(killed).toEqual([]);
	}
});

test('a session that would not end leaves the space running', () => {
	const run: OuterTmuxRunner = args =>
		args[0] === 'list-sessions'
			? {status: 0, stdout: 'agent-api-B2B-1\n', stderr: ''}
			: {status: 1, stdout: '', stderr: 'no'};
	expect(endIdentitySessions(identity, run)).toBe(false);
});
