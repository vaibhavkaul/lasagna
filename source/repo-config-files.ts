// Where a repo's config files are, without loading the config module: the
// space identity stores ask whether a checkout is configured, and they stay
// free of everything config.ts pulls in.
import fs from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';

/**
 * A repo's own config. The name and the format are Pappardelle's, and a repo
 * has no file under Lasagna's name: what only Lasagna has is set in the
 * workdir config.
 */
export const PROJECT_CONFIG_NAME = '.pappardelle.yml';

/** The workdir config, relative to the work dir that holds it. */
export const WORKDIR_CONFIG_FILE = path.join('.lasagna', 'workdir.yml');

/**
 * The work dir whose workdir config applies to a repo: LASAGNA_WORKDIR
 * when it's set (empty turns it off), else the nearest directory at
 * or above `mainRoot` holding `.lasagna/workdir.yml`. It starts from the
 * main checkout because a space's worktree lives under ~/.lasagna/worktrees,
 * outside the work dir.
 */
export function findWorkdir(
	mainRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const override = env['LASAGNA_WORKDIR'];
	if (override !== undefined) return override || undefined;
	let directory = path.resolve(mainRoot);
	for (;;) {
		if (fs.existsSync(path.join(directory, WORKDIR_CONFIG_FILE)))
			return directory;
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

/**
 * Whether the workdir config has a section for `repoName`. A workdir's
 * top-level settings apply to every repo in it, but only a section of its
 * own makes a repo one Lasagna runs in. A file that can't be read or
 * parsed counts as no section here; loading the config reports it.
 */
export function workdirListsRepo(workdir: string, repoName: string): boolean {
	let document: unknown;
	try {
		document = parse(
			fs.readFileSync(path.join(workdir, WORKDIR_CONFIG_FILE), 'utf8'),
		);
	} catch {
		return false;
	}

	const repos = isMap(document) ? document['repos'] : undefined;
	if (!isMap(repos) || !Object.hasOwn(repos, repoName)) return false;
	// A repo listed with nothing under it is still listed.
	const section = repos[repoName];
	return section === null || isMap(section);
}

function isMap(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether the repo checked out at `mainRoot` is configured: its main checkout
 * holds a project config, or its workdir config has a section for it.
 */
export function mainCheckoutHasConfig(mainRoot: string): boolean {
	if (fs.existsSync(path.join(mainRoot, PROJECT_CONFIG_NAME))) return true;
	const workdir = findWorkdir(mainRoot);
	return (
		workdir !== undefined && workdirListsRepo(workdir, path.basename(mainRoot))
	);
}
