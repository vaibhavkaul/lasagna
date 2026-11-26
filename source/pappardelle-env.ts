// An installed Pappardelle marks the sessions it starts with PAPPARDELLE_*
// variables, PAPPARDELLE_REPO on every one, and its hooks take any session
// carrying them for one of its own spaces. Lasagna runs beside it, and both
// tools' plugins load in every agent session on the machine, so each has to
// tell its own sessions from the other's. Lasagna's carry LASAGNA_REPO.

/** Whether this process runs in a session Pappardelle started, not Lasagna. */
export function inPappardelleSession(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return Boolean(env['PAPPARDELLE_REPO']) && !env['LASAGNA_REPO'];
}

/**
 * The same, as this process was started. dropPappardelleEnv() changes what
 * inPappardelleSession() answers, and this is read when the module loads.
 */
export const startedInPappardelleSession = inPappardelleSession();

/**
 * Drop Pappardelle's variables from this process, so that nothing Lasagna
 * starts inherits them. Lasagna launched from a pane of Pappardelle's has
 * them, and a tmux server keeps the environment of the client that started
 * it: every session Lasagna then created on its inner server would carry
 * that pane's PAPPARDELLE_SPACE, and Pappardelle's hooks would report all of
 * them as that one space.
 */
export function dropPappardelleEnv(env: NodeJS.ProcessEnv = process.env): void {
	for (const name of Object.keys(env)) {
		if (name.startsWith('PAPPARDELLE_')) Reflect.deleteProperty(env, name);
	}
}
