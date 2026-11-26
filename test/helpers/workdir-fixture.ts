// A work dir holding real checkouts, for tests of code that serves more than
// one repo. Repo names carry a random suffix: state is kept by repo name under
// the run's one HOME, and two test files must not share a repo's stores.
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {writeFiles} from './config-fixtures.ts';
import {tempDir} from './temp-dir.ts';

export type FixtureRepo = {name: string; root: string};

export type WorkdirFixture = {
	/** The work dir, which holds `.lasagna/workdir.yml` when asked for. */
	work: string;
	/** Its pseudo-repo's name, `@<directory name>`. */
	workRepo: string;
	/** The repos by the label they were asked for with. */
	repos: Record<string, FixtureRepo>;
};

const PROFILES = 'version: 1\nprofiles:\n  t:\n    display_name: T\n';

export function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		'git',
		[
			'-C',
			cwd,
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@example.com',
			...args,
		],
		{encoding: 'utf8', stdio: 'pipe'},
	).trim();
}

/**
 * A work dir with one checkout per label, each holding the files given for
 * it (paths relative to the checkout). `workdirConfig` builds the text of
 * `.lasagna/workdir.yml` from the repos' real names; without it the work dir
 * has no workdir config.
 */
export function workdirFixture(options: {
	repos: Record<string, Record<string, string>>;
	workdirConfig?: (names: Record<string, string>) => string;
}): WorkdirFixture {
	const suffix = randomBytes(3).toString('hex');
	const work = path.join(tempDir('lasagna-work-'), `work-${suffix}`);
	writeFiles(work, {'.keep': ''});
	const repos: Record<string, FixtureRepo> = {};
	for (const [label, files] of Object.entries(options.repos)) {
		const name = `${label}-${suffix}`;
		const root = path.join(work, name);
		writeFiles(root, {'.keep': '', ...files});
		git(root, 'init', '-q');
		git(root, 'commit', '-q', '--allow-empty', '-m', 'initial');
		repos[label] = {name, root};
	}

	if (options.workdirConfig) {
		const names = Object.fromEntries(
			Object.entries(repos).map(([label, repo]) => [label, repo.name]),
		);
		writeFiles(work, {
			'.lasagna/workdir.yml': options.workdirConfig(names),
		});
	}

	return {work, workRepo: `@${path.basename(work)}`, repos};
}

/** A workdir config that lists every repo with nothing under it. */
export function listRepos(names: Record<string, string>): string {
	return `${PROFILES}repos:\n${Object.values(names)
		.map(name => `  ${name}:\n`)
		.join('')}`;
}
