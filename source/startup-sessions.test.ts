import {test, expect} from 'bun:test';
import {clearStaleOuterSessions} from './startup-sessions.ts';
import type {OuterTmuxRunner} from './tmux.ts';

function defaultSocket(sessions: string[]) {
	const killed: string[] = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions')
			return {status: 0, stdout: `${sessions.join('\n')}\n`};
		// The target is an exact match, `=name:`.
		if (args[0] === 'kill-session') killed.push((args[2] ?? '').slice(1, -1));
		return {status: 0, stdout: ''};
	};
	return {runner, killed};
}

test("a work dir's TUI leaves the default socket's sessions named after its repos alone", () => {
	const {runner, killed} = defaultSocket([
		'lasagna-wd-work',
		// The user's own, named like a repo the work dir lists.
		'agent-api-notes',
		'claude-web-scratch',
		'companion-api-logs',
		'lazygit-web-main',
		'agent-otto-deploy',
	]);
	expect(
		clearStaleOuterSessions({own: '@work', listed: ['api', 'web']}, runner),
	).toBe(0);
	expect(killed).toEqual([]);
});

test('a TUI still clears what an old run of its own repo left on the default socket', () => {
	const {runner, killed} = defaultSocket([
		'lasagna-api',
		'claude-api-STA-1',
		'companion-api-STA-1',
		'agent-web-STA-2',
	]);
	expect(clearStaleOuterSessions({own: 'api', listed: []}, runner)).toBe(2);
	expect(killed).toEqual(['claude-api-STA-1', 'companion-api-STA-1']);
});
