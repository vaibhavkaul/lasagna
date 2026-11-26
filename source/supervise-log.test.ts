import {test, expect} from 'bun:test';
import {callerFromEnv} from './supervise-log.ts';

test("the caller is the agent's space, main for the main space's agent, else the user", () => {
	expect(callerFromEnv({LASAGNA_SPACE: 'STA-1', LASAGNA_REPO: 'r'})).toBe(
		'STA-1',
	);
	expect(callerFromEnv({LASAGNA_REPO: 'r'})).toBe('main');
	expect(callerFromEnv({})).toBe('user');
});
