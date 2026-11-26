/**
 * Whether a test run drops an inherited variable. A run started inside a
 * space, or by a timer service, inherits that space's LASAGNA_*, and the
 * state ones (LASAGNA_STATE_DB, LASAGNA_STATUS_SOCKET, ...) point past
 * any HOME at the real database. A test run keeps only its state mode and its
 * own LASAGNA_TEST_* switches.
 */
export function isHostPappardelleEnv(name: string): boolean {
	return (
		name.startsWith('LASAGNA_') &&
		name !== 'LASAGNA_SQLITE_STATE' &&
		!name.startsWith('LASAGNA_TEST_')
	);
}

/** Copy `source` without the variables {@link isHostPappardelleEnv} drops. */
export function stripHostPappardelleEnv(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(source).filter(([key]) => !isHostPappardelleEnv(key)),
	);
}
