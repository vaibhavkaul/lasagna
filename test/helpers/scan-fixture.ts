// A work dir for the scan and setup tests: real git checkouts with branches
// and commits that name ticket keys, the things scan must pass over, and a
// `gh` on PATH that answers `pr list` from canned PRs.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {tempDir} from './temp-dir.ts';

export type WorkdirFixture = {
	root: string;
	/** The work dir. */
	work: string;
	/** A directory at the front of `env.PATH`, for stubs. */
	bin: string;
	/** The environment for the code under test: PATH with the stubs first. */
	env: NodeJS.ProcessEnv;
	/** Each `gh` call's arguments, one call per entry. */
	ghCalls: () => string[];
	git: (repo: string, ...args: string[]) => string;
};

const DAY_MS = 86_400_000;

export function writeExecutable(file: string, script: string): void {
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(file, script, {mode: 0o755});
}

/** `git init` in a new directory, with a first commit under `subject`. */
export function initRepo(
	directory: string,
	options: {branch?: string; subject?: string; daysAgo?: number} = {},
): void {
	fs.mkdirSync(directory, {recursive: true});
	git(directory, 'init', '--quiet', '-b', options.branch ?? 'main');
	commit(directory, options.subject ?? 'Initial commit', options.daysAgo);
}

export function git(repo: string, ...args: string[]): string {
	return execFileSync('git', ['-C', repo, ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

/** An empty commit, dated `daysAgo` days back. */
export function commit(repo: string, subject: string, daysAgo = 0): void {
	const date = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
	execFileSync(
		'git',
		[
			'-C',
			repo,
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@example.com',
			'commit',
			'--quiet',
			'--allow-empty',
			'-m',
			subject,
		],
		{
			env: {...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
}

/** The PRs the fixture's gh lists for acme/api. */
export const API_PRS = [
	{
		title: '[B2B-3127] Add payments',
		body: 'Digests use SHA-256. Follows INC-739.',
		headRefName: 'B2B-3127__payments',
	},
	{
		title: 'Fix encoding',
		body: 'Dates are ISO-8601 now.',
		headRefName: 'fix-encoding',
	},
	{title: 'OPS-4 Rotate keys', body: '', headRefName: 'rotate-keys'},
];

/**
 * work/
 *   api/               checkout, origin github.com/acme/api, CLAUDE.md,
 *                      README.md, .pappardelle.yml, TypeScript and Python
 *     nested/          a checkout inside it
 *   api-wt-PLAT-1/     a worktree of api
 *   web/               checkout with no origin, on master
 *   group/tool/        checkout two levels down, whose gh call fails
 *   mirror.git/        bare repo
 *   node_modules/pkg/  a checkout that is somebody's dependency
 *   .cache/repo/       a checkout in a hidden directory
 *   link -> api        symlink
 */
export function workdirFixture(): WorkdirFixture {
	const root = tempDir('lasagna-scan-');
	const work = path.join(root, 'work');
	const bin = path.join(root, 'bin');
	const ghLog = path.join(root, 'gh-calls');
	fs.mkdirSync(bin);

	const api = path.join(work, 'api');
	// The oldest commit comes first, as in a real history: git stops reading
	// at the first commit older than --since.
	initRepo(api, {subject: 'OLD-1 from before the window', daysAgo: 400});
	commit(api, 'B2B-3127: add payments');
	for (const [file, content] of Object.entries({
		'src/a.ts': '',
		'src/b.ts': '',
		'src/c.tsx': '',
		'tool.py': '',
		'CLAUDE.md': '# api\n\nRun `yarn install` in a new worktree.\n',
		'README.md': '# api\n',
		'.pappardelle.yml':
			'version: 1\nprofiles:\n  api:\n    display_name: API\n',
	})) {
		fs.mkdirSync(path.dirname(path.join(api, file)), {recursive: true});
		fs.writeFileSync(path.join(api, file), content);
	}

	git(api, 'add', '.');
	commit(api, 'Handle UTF-8 input');
	commit(api, '[PLAT-12] Tighten checks');
	commit(api, 'Use SHA-256 for digests');
	git(api, 'remote', 'add', 'origin', 'https://github.com/acme/api.git');
	git(api, 'branch', 'B2B-3127__payments');
	git(api, 'branch', 'PLAT-5751-reset-link');
	for (const branch of ['main', 'B2B-3127__payments', 'B2B-9-old'])
		git(api, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
	git(
		api,
		'symbolic-ref',
		'refs/remotes/origin/HEAD',
		'refs/remotes/origin/main',
	);
	git(api, 'worktree', 'add', '--quiet', '-b', 'PLAT-1-wt', '../api-wt-PLAT-1');
	initRepo(path.join(api, 'nested'));

	const web = path.join(work, 'web');
	initRepo(web, {branch: 'master', subject: 'PLAT-7 first screen'});
	fs.writeFileSync(path.join(web, 'App.kt'), '');
	git(web, 'add', '.');
	commit(web, 'Add the app');
	git(web, 'branch', 'PLAT-7-first-screen');

	const tool = path.join(work, 'group', 'tool');
	initRepo(tool, {subject: 'ONC-5 page the right team'});
	git(tool, 'remote', 'add', 'origin', 'git@github.com:acme/tool.git');
	git(tool, 'branch', 'ONC-5-paging');

	execFileSync('git', [
		'init',
		'--quiet',
		'--bare',
		path.join(work, 'mirror.git'),
	]);
	initRepo(path.join(work, 'node_modules', 'pkg'));
	initRepo(path.join(work, '.cache', 'repo'));
	fs.symlinkSync(api, path.join(work, 'link'));

	writeExecutable(
		path.join(bin, 'gh'),
		`#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}
case "$*" in
	*"--repo acme/api "*) cat <<'JSON'
${JSON.stringify(API_PRS)}
JSON
	;;
	*) echo "HTTP 404: Not Found" >&2; exit 1 ;;
esac
`,
	);

	return {
		root,
		work,
		bin,
		env: {...process.env, PATH: `${bin}:${process.env['PATH']!}`},
		ghCalls: () =>
			fs.existsSync(ghLog)
				? fs.readFileSync(ghLog, 'utf8').trim().split('\n')
				: [],
		git,
	};
}
