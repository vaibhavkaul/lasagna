import {test, expect} from 'bun:test';
import {
	callerSpace,
	NoTargetSpaceError,
	resolveTargetSpace,
} from './space-target.ts';

const resolve = (raw: string) => `resolved:${raw}`;

test('--space resolves like a typed issue key', () => {
	expect(
		resolveTargetSpace({
			flag: '696',
			env: {LASAGNA_SPACE: 'STA-1'},
			resolve,
		}),
	).toBe('resolved:696');
});

test('LASAGNA_SPACE is the exact key and is not normalized', () => {
	expect(resolveTargetSpace({env: {LASAGNA_SPACE: 'DEMO-2'}, resolve})).toBe(
		'DEMO-2',
	);
});

test('with neither, the caller is told it is not in a workspace', () => {
	for (const env of [{}, {LASAGNA_SPACE: ' '}]) {
		expect(() => resolveTargetSpace({env, resolve})).toThrow(
			NoTargetSpaceError,
		);
	}
});

const checkout = {repoName: 'repo', mainRoot: '/w/repo'};

/** Identities in which every path is in `key`'s worktree. */
const allIn = (key: string) => () => ({
	atPath: () => ({
		kind: 'identity' as const,
		identity: {
			repo: 'repo',
			key,
			worktreePath: '/w',
			tmux: {socket: 's', agentSession: 'a', companionSession: 'c'},
		},
	}),
});

test('LASAGNA_SPACE names the space wherever the caller runs', () => {
	expect(
		callerSpace({
			env: {LASAGNA_SPACE: 'STA-9'},
			cwd: '/w',
			checkout: {kind: 'checkout', checkout},
			identities: allIn('STA-1'),
		}),
	).toStrictEqual({kind: 'env', key: 'STA-9'});
});

test('outside a git checkout only LASAGNA_SPACE names a space', () => {
	const options = {
		cwd: '/w',
		checkout: {kind: 'not-in-a-repo'} as const,
		identities: allIn('STA-1'),
	};
	expect(callerSpace({...options, env: {}})).toStrictEqual({kind: 'none'});
	expect(
		callerSpace({...options, env: {LASAGNA_SPACE: 'STA-1'}}),
	).toStrictEqual({
		kind: 'env',
		key: 'STA-1',
	});
});
