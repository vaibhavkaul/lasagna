// A work dir: a directory holding `.lasagna/workdir.yml` and the repos that
// file lists. What the config layers say of one repo is config.ts's business;
// this is the list of repos itself.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'yaml';
import {
	WORKDIR_CONFIG_FILE,
	findWorkdir,
	workdirRepoName,
} from './repo-config-files.ts';

export type WorkdirRepo = {
	/** The section's name, which is the repo's directory name. */
	name: string;
	/** The repo's main checkout. */
	root: string;
};

export type Workdir = {
	root: string;
	/** The pseudo-repo its own spaces are kept under, `@<directory name>`. */
	repoName: string;
	repos: WorkdirRepo[];
};

function isMap(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Where a repo section's checkout is: `path` when the section sets one
 * (relative to the work dir, or `~/…`), else the directory named after the
 * section.
 */
export function workdirRepoRoot(
	workdir: string,
	name: string,
	section: unknown,
	home = os.homedir(),
): string {
	const custom = isMap(section) ? section['path'] : undefined;
	if (typeof custom !== 'string' || !custom) return path.join(workdir, name);
	if (custom === '~') return home;
	if (custom.startsWith('~/')) return path.join(home, custom.slice(2));
	return path.resolve(workdir, custom);
}

/**
 * The repos a work dir's config lists whose directories exist, in the order
 * the file lists them. A file that can't be read or parsed lists none here;
 * loading the config reports it.
 */
export function workdirRepos(workdir: string): WorkdirRepo[] {
	let document: unknown;
	try {
		document = parse(
			fs.readFileSync(path.join(workdir, WORKDIR_CONFIG_FILE), 'utf8'),
		);
	} catch {
		return [];
	}

	const sections = isMap(document) ? document['repos'] : undefined;
	if (!isMap(sections)) return [];
	return Object.entries(sections).flatMap(([name, section]) => {
		const root = workdirRepoRoot(workdir, name, section);
		try {
			return fs.statSync(root).isDirectory() ? [{name, root}] : [];
		} catch {
			return [];
		}
	});
}

export function readWorkdir(root: string): Workdir {
	const resolved = path.resolve(root);
	return {
		root: resolved,
		repoName: workdirRepoName(resolved),
		repos: workdirRepos(resolved),
	};
}

/**
 * The work dir a directory is in: the nearest one at or above it, or the one
 * LASAGNA_WORKDIR names.
 */
export function workdirAt(
	directory: string,
	env: NodeJS.ProcessEnv = process.env,
): Workdir | undefined {
	const root = findWorkdir(directory, env);
	return root === undefined ? undefined : readWorkdir(root);
}
