import {test, expect} from 'bun:test';
import {dropPappardelleEnv, inPappardelleSession} from './pappardelle-env.ts';

test("a session with Pappardelle's variables and none of Lasagna's is Pappardelle's", () => {
	expect(inPappardelleSession({PAPPARDELLE_REPO: 'app'})).toBe(true);
	expect(
		inPappardelleSession({PAPPARDELLE_REPO: 'app', PAPPARDELLE_SPACE: 'STA-1'}),
	).toBe(true);
});

test("a session in neither tool's space, and one of Lasagna's, is not Pappardelle's", () => {
	expect(inPappardelleSession({})).toBe(false);
	expect(inPappardelleSession({LASAGNA_REPO: 'app'})).toBe(false);
	// Lasagna started from one of Pappardelle's panes before it dropped them.
	expect(
		inPappardelleSession({PAPPARDELLE_REPO: 'app', LASAGNA_REPO: 'app'}),
	).toBe(false);
});

test("dropping Pappardelle's variables leaves every other one", () => {
	const env = {
		PAPPARDELLE_REPO: 'app',
		PAPPARDELLE_SPACE: 'STA-1',
		PAPPARDELLE_TMUX_SOCKET: 'pappardelle_inner',
		LASAGNA_SQLITE_STATE: '1',
		PATH: '/usr/bin',
	};
	dropPappardelleEnv(env);
	expect(env).toStrictEqual({LASAGNA_SQLITE_STATE: '1', PATH: '/usr/bin'});
});
