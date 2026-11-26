import {test, expect} from 'bun:test';
import path from 'node:path';
import {writeFiles} from '../test/helpers/config-fixtures.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	git,
	listRepos,
	workdirFixture,
} from '../test/helpers/workdir-fixture.ts';
import {repoRootsAt, type RepoRoots} from './config.ts';
import {startsTui, workdirFlag, workdirMode} from './workdir-mode.ts';

function checkoutAt(directory: string): RepoRoots | undefined {
	try {
		return repoRootsAt(directory);
	} catch {
		return undefined;
	}
}

const mode = (argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
	workdirMode(argv, {cwd, env, checkoutAt});

const PROFILES = 'version: 1\nprofiles:\n  t:\n    display_name: T\n';

function fixture() {
	return workdirFixture({
		repos: {
			// Listed in the work dir.
			api: {},
			// Its own config file, and not listed.
			web: {'.pappardelle.yml': PROFILES},
			// A checkout the work dir knows nothing of.
			scratch: {},
		},
		workdirConfig: names => listRepos({api: names['api']!}),
	});
}

test('a start with no verb or prompt starts the TUI, whatever flags it has', () => {
	expect(startsTui([])).toBe(true);
	expect(startsTui(['--no-layout'])).toBe(true);
	expect(startsTui(['--workdir', '/work', '--no-layout'])).toBe(true);
	expect(startsTui(['spaces'])).toBe(false);
	expect(startsTui(['--profile', 'p', 'fix the thing'])).toBe(false);
	expect(startsTui(['STA-12'])).toBe(false);
});

test('--workdir is read in both spellings', () => {
	expect(workdirFlag(['--workdir', '/w'])).toEqual({
		index: 1,
		value: '/w',
		joined: false,
	});
	expect(workdirFlag(['--no-layout', '--workdir=/w'])).toEqual({
		index: 1,
		value: '/w',
		joined: true,
	});
	expect(workdirFlag(['--workspace', '/w'])).toBeUndefined();
});

test('started at the work dir\u2019s root, or in a plain directory below it, the TUI is the work dir\u2019s', () => {
	const {work} = fixture();
	expect(mode([], work)).toEqual({kind: 'workdir', root: work, argv: []});
	writeFiles(work, {'notes/todo.md': ''});
	expect(mode(['--no-layout'], path.join(work, 'notes'))).toEqual({
		kind: 'workdir',
		root: work,
		argv: ['--no-layout'],
	});
});

test('started in a configured repo the TUI is that repo\u2019s, as it always was', () => {
	const {repos} = fixture();
	// One the work dir lists, and one with a config file of its own.
	expect(mode([], repos['api']!.root)).toEqual({kind: 'repo'});
	expect(mode([], repos['web']!.root)).toEqual({kind: 'repo'});
});

test('started in a worktree of a configured repo, outside the work dir, it is still that repo\u2019s', () => {
	const {repos} = fixture();
	const worktree = path.join(tempDir('lasagna-worktrees-'), 'API-7');
	git(repos['api']!.root, 'worktree', 'add', '-q', '-b', 'API-7', worktree);
	expect(mode([], worktree)).toEqual({kind: 'repo'});
});

test('started in a checkout the work dir does not configure, the TUI is the work dir\u2019s', () => {
	const {work, repos} = fixture();
	expect(mode([], repos['scratch']!.root)).toEqual({
		kind: 'workdir',
		root: work,
		argv: [],
	});
});

test('a work dir whose root is a checkout of its own is still the work dir there, configured or not', () => {
	const {work, repos} = fixture();
	git(work, 'init', '-q');
	git(work, 'commit', '-q', '--allow-empty', '-m', 'the work dir is a repo');
	expect(mode([], work)).toEqual({kind: 'workdir', root: work, argv: []});
	// A config file at its root does not make it a repo of itself: a command
	// run here is about the work dir, and so is the TUI.
	writeFiles(work, {'.pappardelle.yml': PROFILES, 'notes/todo.md': ''});
	expect(mode([], work)).toEqual({kind: 'workdir', root: work, argv: []});
	expect(mode([], path.join(work, 'notes'))).toEqual({
		kind: 'workdir',
		root: work,
		argv: [],
	});
	// The repos it lists are still theirs.
	expect(mode([], repos['api']!.root)).toEqual({kind: 'repo'});
});

test('a work dir inside a checkout is the work dir at its root, not that checkout', () => {
	const outer = tempDir('lasagna-outer-');
	git(outer, 'init', '-q');
	git(outer, 'commit', '-q', '--allow-empty', '-m', 'outer');
	writeFiles(outer, {
		'.pappardelle.yml': PROFILES,
		'work/.lasagna/workdir.yml': PROFILES,
		'elsewhere/readme.md': '',
	});
	const work = path.join(outer, 'work');
	expect(mode([], work)).toEqual({kind: 'workdir', root: work, argv: []});
	// The rest of the outer checkout is that repo's.
	expect(mode([], outer)).toEqual({kind: 'repo'});
	expect(mode([], path.join(outer, 'elsewhere'))).toEqual({kind: 'repo'});
});

test('outside every work dir nothing changes', () => {
	const outside = tempDir('lasagna-outside-');
	expect(mode([], outside)).toEqual({kind: 'repo'});
	git(outside, 'init', '-q');
	expect(mode([], outside)).toEqual({kind: 'repo'});
});

test('a verb or a prompt is never turned into a work dir start', () => {
	const {work, repos} = fixture();
	expect(mode(['spaces'], work)).toEqual({kind: 'repo'});
	expect(mode(['fix', 'the', 'thing'], repos['scratch']!.root)).toEqual({
		kind: 'repo',
	});
});

test('--workdir names the work dir from anywhere, and is passed on as a full path', () => {
	const {work, repos} = fixture();
	expect(mode(['--workdir', work], repos['api']!.root)).toEqual({
		kind: 'workdir',
		root: work,
		argv: ['--workdir', work],
	});
	// The TUI starts again inside tmux from another directory.
	const relative = path.relative(repos['api']!.root, work);
	expect(
		mode([`--workdir=${relative}`, '--no-layout'], repos['api']!.root),
	).toEqual({
		kind: 'workdir',
		root: work,
		argv: [`--workdir=${work}`, '--no-layout'],
	});
	// With a verb, the verb runs for the work dir.
	expect(mode(['--workdir', work, 'spaces'], '/').kind).toBe('workdir');
});

test('--workdir on a directory with no workdir config is refused', () => {
	const plain = tempDir('lasagna-plain-');
	const result = mode(['--workdir', plain], plain);
	expect(result.kind).toBe('error');
	if (result.kind === 'error')
		expect(result.message).toBe(
			`${plain} is not a work dir: it has no .lasagna/workdir.yml`,
		);
});

test('LASAGNA_WORKDIR names the work dir of a start outside every checkout, and empty turns it off', () => {
	const {work} = fixture();
	const outside = tempDir('lasagna-outside-');
	expect(mode([], outside, {LASAGNA_WORKDIR: work})).toEqual({
		kind: 'workdir',
		root: work,
		argv: [],
	});
	expect(mode([], work, {LASAGNA_WORKDIR: ''})).toEqual({kind: 'repo'});
});
