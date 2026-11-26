// `lasagna scan [dir]`: what a work dir holds, found without an agent.
// It finds the checkouts, reads each one's remote, default branch, languages
// and config files, and counts the ticket keys its branches, commits and PRs
// name. `setup` starts from this.

import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs, promisify} from 'node:util';
import {remoteProject} from './git-remotes.ts';
import {pLimit} from './providers/concurrency.ts';
import {PROJECT_CONFIG_NAME, findWorkdir} from './repo-config-files.ts';

const execFileAsync = promisify(execFile);

/** Where scan writes its result, relative to the work dir. */
export const WORKDIR_SCAN_FILE = path.join('.lasagna', 'scan.json');

export const SCAN_USAGE =
	'Usage: lasagna scan [dir] [--depth N] [--json] [--dry-run]';

export const SCAN_HELP = `
	Usage
	  $ lasagna scan [dir] [--depth N] [--json] [--dry-run]

	Finds the repos in a work dir and what their history says about them,
	without running an agent. dir defaults to the nearest work dir above the
	working directory (one holding .lasagna/workdir.yml), else the working
	directory.

	A repo is a directory whose .git is a directory. Worktrees (.git is a
	file), bare repos, checkouts inside another checkout, node_modules and
	hidden directories are skipped and counted.

	For each repo it reads the origin URL, the default branch, the main
	languages, which of .pappardelle.yml, CLAUDE.md, AGENTS.md and a README
	it has, and the ticket keys (ABC-123) in its branch names, the commit
	subjects of the last 180 days and its last 200 PRs (when origin is on
	github.com and gh works). A prefix counts as a ticket prefix when a
	branch name has it or a PR title opens with it; one found only in prose,
	like UTF-8 or SHA-256, is dropped. Each prefix then gets the share of its
	ticket keys found in each repo, and a default repo: where your local
	branches with the prefix are (when they name three keys or more), else
	the repo with the largest share.

	Prints a table and writes <dir>/.lasagna/scan.json. A repo or a gh call
	that fails is reported with the repo, never fatal.

	Options
	  --depth N   How many levels below dir to look for repos (default 2)
	  --json      Print the result as JSON instead of the table
	  --dry-run   Don't write scan.json

	Exit codes
	  0  Scanned
	  1  dir can't be read, or scan.json can't be written
	  2  Usage
`;

const DEFAULT_DEPTH = 2;
const COMMIT_WINDOW_DAYS = 180;
const PR_LIMIT = 200;
const REPO_CONCURRENCY = 4;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

// ============================================================================
// Ticket keys
// ============================================================================

// A key ends where a letter or digit would continue it, so B2B-3127__slug and
// PLAT-5751-slug both give their key, and the 12 in ABC-12x gives none.
const TICKET_KEY = /(?<![A-Za-z\d])[A-Z][A-Z\d]+-\d+(?![A-Za-z\d])/g;
const LEADING_TICKET_KEY = /^[^A-Za-z\d]*([A-Z][A-Z\d]+-\d+)(?![A-Za-z\d])/;

/** Every ticket key in `text`, in order, repeats included. */
export function extractTicketKeys(text: string): string[] {
	return text.match(TICKET_KEY) ?? [];
}

/** The keys a title opens with: `[PLAT-1][B2B-2] Fix INC-3` gives the first two. */
export function leadingTicketKeys(title: string): string[] {
	const keys: string[] = [];
	let rest = title;
	for (;;) {
		const match = LEADING_TICKET_KEY.exec(rest);
		if (!match) return keys;
		keys.push(match[1]!);
		rest = rest.slice(match[0].length);
	}
}

export function ticketPrefix(key: string): string {
	return key.slice(0, key.lastIndexOf('-'));
}

/** How many branch names, commit subjects and PRs name a prefix. */
export type PrefixMentions = {
	/** Branch names, a remote's copy of a local branch counted once. */
	branches: number;
	commits: number;
	prs: number;
};

/** One prefix's evidence in one repo. */
export type PrefixEvidence = PrefixMentions & {
	/** Each distinct key, with how many branches, commits and PRs name it. */
	keys: Record<string, number>;
	/**
	 * The keys a local branch names. A remote holds everyone's branches; the
	 * local ones are the work done in this checkout.
	 */
	localKeys: string[];
	/**
	 * Whether a branch name has the prefix, or a PR title opens with it. The
	 * rest of a title, a PR's body and a commit subject are prose, where
	 * UTF-8, SHA-256 and ISO-8601 look like keys too.
	 */
	named: boolean;
};

export type PullRequestText = {
	title?: string | null;
	body?: string | null;
	headRefName?: string | null;
};

/**
 * Count the ticket prefixes in a repo's branch names, commit subjects and
 * PRs. A branch, commit or PR counts once for a prefix however many of the
 * prefix's keys it names.
 */
export function collectTicketEvidence(input: {
	/** Every branch name, local or remote, once each. */
	branches: readonly string[];
	/** The names among `branches` that are local branches. */
	localBranches?: readonly string[];
	commits: readonly string[];
	prs: readonly PullRequestText[];
}): Record<string, PrefixEvidence> {
	const found = new Map<string, PrefixEvidence>();
	const entryFor = (prefix: string): PrefixEvidence => {
		let entry = found.get(prefix);
		if (!entry) {
			entry = {
				keys: {},
				localKeys: [],
				branches: 0,
				commits: 0,
				prs: 0,
				named: false,
			};
			found.set(prefix, entry);
		}

		return entry;
	};

	const add = (source: keyof PrefixMentions, text: string) => {
		const keys = new Set(extractTicketKeys(text));
		for (const key of keys) {
			const entry = entryFor(ticketPrefix(key));
			entry.keys[key] = (entry.keys[key] ?? 0) + 1;
		}

		for (const prefix of new Set([...keys].map(key => ticketPrefix(key))))
			entryFor(prefix)[source]++;
		return keys;
	};

	const local = new Set(input.localBranches);
	for (const branch of input.branches) {
		for (const key of add('branches', branch)) {
			const entry = entryFor(ticketPrefix(key));
			entry.named = true;
			if (local.has(branch) && !entry.localKeys.includes(key))
				entry.localKeys.push(key);
		}
	}

	for (const subject of input.commits) add('commits', subject);
	for (const pr of input.prs) {
		add('prs', [pr.title, pr.headRefName, pr.body].filter(Boolean).join('\n'));
		for (const key of [
			...leadingTicketKeys(pr.title ?? ''),
			...extractTicketKeys(pr.headRefName ?? ''),
		]) {
			entryFor(ticketPrefix(key)).named = true;
		}
	}

	return Object.fromEntries(found);
}

/** A prefix across the work dir. */
export type PrefixSummary = PrefixCounts & {
	/**
	 * The repo a new ticket with this prefix most likely belongs to: the one
	 * with the largest share in `localRepos` when local branches name three
	 * keys or more, else the one with the largest share in `repos`.
	 */
	defaultRepo: string;
	/** Each repo's share of the prefix's keys, largest first. */
	repos: Record<string, number>;
	/**
	 * Each repo's share of the keys local branches name, largest first.
	 * Absent when no local branch has the prefix.
	 */
	localRepos?: Record<string, number>;
};

export type PrefixCounts = PrefixMentions & {
	/** Distinct ticket keys; across repos, counted per repo and summed. */
	keys: number;
	/** The keys among them that a local branch names. */
	localKeys: number;
};

function countsOf({
	keys,
	localKeys,
	named,
	...mentions
}: PrefixEvidence): PrefixCounts {
	return {
		keys: Object.keys(keys).length,
		localKeys: localKeys.length,
		...mentions,
	};
}

/**
 * How many keys local branches must name before they say where a prefix is
 * worked on. One or two can be a colleague's branch checked out for review.
 */
const MIN_LOCAL_KEYS = 3;

/** Each repo's share of `total`, largest first, leaving out repos with none. */
function shares(
	byRepo: ReadonlyArray<{repo: string; count: number}>,
	total: number,
): Record<string, number> {
	return Object.fromEntries(
		byRepo
			.filter(({count}) => count > 0)
			.sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo))
			.map(({repo, count}) => [
				repo,
				Math.round((count / total) * 1000) / 1000,
			]),
	);
}

/**
 * The weighted map from ticket prefix to repos: each repo's share of the
 * prefix's distinct ticket keys. Keys rather than mentions, so a ticket with
 * ten commits weighs the same as one with a single branch.
 *
 * A prefix's default repo is where the local branches with the prefix are,
 * since that is where the person at this work dir works on it; a prefix with
 * fewer than `MIN_LOCAL_KEYS` keys in local branches takes the repo with the
 * largest share. A remote's branches, commits and PRs are everyone's: PLAT
 * can have most of its keys in one team's repo while the local PLAT branches
 * are all in another.
 *
 * A prefix that no repo has in a branch name or at the start of a PR title
 * is dropped as prose (see `PrefixEvidence.named`).
 */
export function buildPrefixMap(
	repos: ReadonlyArray<{
		name: string;
		evidence: Record<string, PrefixEvidence>;
	}>,
): {
	prefixes: Record<string, PrefixSummary>;
	dropped: Record<string, PrefixCounts>;
} {
	const totals = new Map<
		string,
		{
			counts: PrefixCounts;
			named: boolean;
			byRepo: Array<{repo: string; counts: PrefixCounts}>;
		}
	>();
	for (const {name, evidence} of repos) {
		for (const [prefix, found] of Object.entries(evidence)) {
			const counts = countsOf(found);
			const total = totals.get(prefix);
			if (total) {
				for (const field of Object.keys(counts) as Array<keyof PrefixCounts>)
					total.counts[field] += counts[field];
				total.named ||= found.named;
				total.byRepo.push({repo: name, counts});
			} else {
				totals.set(prefix, {
					counts: {...counts},
					named: found.named,
					byRepo: [{repo: name, counts}],
				});
			}
		}
	}

	const prefixes: Array<[string, PrefixSummary]> = [];
	const dropped: Array<[string, PrefixCounts]> = [];
	for (const [prefix, {counts, named, byRepo}] of totals) {
		if (!named) {
			dropped.push([prefix, counts]);
			continue;
		}

		const all = shares(
			byRepo.map(({repo, counts: {keys}}) => ({repo, count: keys})),
			counts.keys,
		);
		const local = shares(
			byRepo.map(({repo, counts: {localKeys}}) => ({repo, count: localKeys})),
			counts.localKeys,
		);
		prefixes.push([
			prefix,
			{
				...counts,
				defaultRepo:
					counts.localKeys >= MIN_LOCAL_KEYS
						? Object.keys(local)[0]!
						: Object.keys(all)[0]!,
				repos: all,
				...(counts.localKeys > 0 ? {localRepos: local} : {}),
			},
		]);
	}

	const byKeys = (
		a: [string, PrefixCounts],
		b: [string, PrefixCounts],
	): number => b[1].keys - a[1].keys || a[0].localeCompare(b[0]);
	return {
		prefixes: Object.fromEntries(prefixes.sort(byKeys)),
		dropped: Object.fromEntries(dropped.sort(byKeys)),
	};
}

// ============================================================================
// Finding checkouts
// ============================================================================

export type SkipReason =
	| 'worktree'
	| 'bare'
	| 'nested'
	| 'hidden'
	| 'node_modules'
	| 'symlink'
	| 'invalid_name'
	| 'unreadable';

/** Each reason as the table names it, for one and for several. */
const SKIP_REASON_LABELS: Record<SkipReason, [string, string]> = {
	worktree: ['worktree (.git is a file)', 'worktrees (.git is a file)'],
	bare: ['bare repo', 'bare repos'],
	nested: [
		'checkout inside another checkout',
		'checkouts inside another checkout',
	],
	hidden: ['hidden directory', 'hidden directories'],
	node_modules: ['node_modules', 'node_modules'],
	symlink: ['symlink', 'symlinks'],
	invalid_name: [
		'repo whose name starts with @',
		'repos whose name starts with @',
	],
	unreadable: [
		'directory that could not be read',
		'directories that could not be read',
	],
};

export type Skipped = {path: string; reason: SkipReason};

type DirectoryKind = 'checkout' | 'worktree' | 'bare' | 'plain';

function directoryKind(directory: string): DirectoryKind {
	const dotGit = fs.lstatSync(path.join(directory, '.git'), {
		throwIfNoEntry: false,
	});
	if (dotGit?.isDirectory()) return 'checkout';
	// A linked worktree's .git is a file pointing into its repo, as is a
	// submodule's.
	if (dotGit?.isFile()) return 'worktree';
	const has = (name: string) => fs.existsSync(path.join(directory, name));
	return has('HEAD') && has('objects') && has('refs') ? 'bare' : 'plain';
}

/**
 * The checkouts at or below `root`, down to `maxDepth` levels, and what was
 * passed over on the way. A checkout's own directories are still looked at,
 * within the same depth, so the checkouts and worktrees inside it are
 * reported; its hidden directories and node_modules are not, since no repo
 * was expected there.
 */
export function findCheckouts(
	root: string,
	maxDepth: number,
): {checkouts: string[]; skipped: Skipped[]} {
	const checkouts: string[] = [];
	const skipped: Skipped[] = [];
	const visit = (directory: string, depth: number, inCheckout: boolean) => {
		const kind = directoryKind(directory);
		if (kind === 'worktree' || kind === 'bare') {
			skipped.push({path: directory, reason: kind});
			return;
		}

		let inside = inCheckout;
		if (kind === 'checkout') {
			if (inCheckout) {
				skipped.push({path: directory, reason: 'nested'});
				return;
			}

			// State for spaces that belong to no single repo is kept under a
			// name starting with @, which a repo must not take.
			if (path.basename(directory).startsWith('@')) {
				skipped.push({path: directory, reason: 'invalid_name'});
				return;
			}

			checkouts.push(directory);
			inside = true;
		}

		if (depth >= maxDepth) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, {withFileTypes: true});
		} catch {
			skipped.push({path: directory, reason: 'unreadable'});
			return;
		}

		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const child = path.join(directory, entry.name);
			const skip = (reason: SkipReason) => {
				if (!inside) skipped.push({path: child, reason});
			};

			if (entry.isSymbolicLink()) {
				if (fs.statSync(child, {throwIfNoEntry: false})?.isDirectory())
					skip('symlink');
			} else if (!entry.isDirectory()) {
				continue;
			} else if (entry.name === 'node_modules') {
				skip('node_modules');
			} else if (entry.name.startsWith('.')) {
				skip('hidden');
			} else {
				visit(child, depth + 1, inside);
			}
		}
	};

	visit(root, 0, false);
	return {checkouts, skipped};
}

// ============================================================================
// One repo
// ============================================================================

const LANGUAGES: Record<string, string[]> = {
	TypeScript: ['ts', 'tsx', 'mts', 'cts'],
	JavaScript: ['js', 'jsx', 'mjs', 'cjs'],
	Kotlin: ['kt', 'kts'],
	Java: ['java'],
	Groovy: ['groovy', 'gradle'],
	Scala: ['scala'],
	Python: ['py'],
	Ruby: ['rb'],
	Go: ['go'],
	Rust: ['rs'],
	Swift: ['swift'],
	'Objective-C': ['m', 'mm'],
	C: ['c', 'h'],
	'C++': ['cc', 'cpp', 'hpp'],
	'C#': ['cs'],
	PHP: ['php'],
	Dart: ['dart'],
	Elixir: ['ex', 'exs'],
	Shell: ['sh', 'bash', 'zsh'],
	SQL: ['sql'],
	Terraform: ['tf', 'tfvars', 'hcl'],
	HTML: ['html', 'htm'],
	CSS: ['css', 'scss', 'sass', 'less'],
	Vue: ['vue'],
	Svelte: ['svelte'],
	GraphQL: ['graphql', 'gql'],
	'Protocol Buffers': ['proto'],
	YAML: ['yml', 'yaml'],
	JSON: ['json'],
	Markdown: ['md', 'mdx'],
};

const LANGUAGE_BY_EXTENSION = new Map(
	Object.entries(LANGUAGES).flatMap(([language, extensions]) =>
		extensions.map(extension => [extension, language] as const),
	),
);

const TOP_LANGUAGES = 4;

export type LanguageShare = {language: string; files: number; share: number};

/**
 * The languages of a list of tracked files, most files first, by extension.
 * `share` is of the files whose extension names a language.
 */
export function topLanguages(files: readonly string[]): LanguageShare[] {
	const counts = new Map<string, number>();
	let known = 0;
	for (const file of files) {
		const language = LANGUAGE_BY_EXTENSION.get(
			path.extname(file).slice(1).toLowerCase(),
		);
		if (!language) continue;
		counts.set(language, (counts.get(language) ?? 0) + 1);
		known++;
	}

	return [...counts]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, TOP_LANGUAGES)
		.map(([language, count]) => ({
			language,
			files: count,
			share: Math.round((count / known) * 100) / 100,
		}));
}

export type RepoFiles = {
	'.pappardelle.yml': boolean;
	'CLAUDE.md': boolean;
	'AGENTS.md': boolean;
	/** The README's file name, when there is one. */
	readme: string | null;
};

export type RepoScan = {
	/** The checkout's directory name, which state is keyed by. */
	name: string;
	path: string;
	/** Relative to the work dir; '.' when the work dir is the checkout. */
	relativePath: string;
	originUrl: string | null;
	/** owner/repo when origin is on github.com. */
	github: string | null;
	defaultBranch: string | null;
	/** `fallback` when origin/HEAD is unset and a main or master branch was taken. */
	defaultBranchSource: 'origin/HEAD' | 'fallback' | null;
	languages: LanguageShare[];
	files: RepoFiles;
	tickets: {
		/** How many of each were read; `prs` is null when PRs weren't read. */
		read: {branches: number; commits: number; prs: number | null};
		/** Why PRs weren't read. */
		prsSkipped?: string;
		/** The prefixes kept by the work dir's prefix map, most keys first. */
		prefixes: Record<string, PrefixCounts & {examples: string[]}>;
	};
	/**
	 * The prefix most of the keys in local branch names have, when they name
	 * three or more, else the prefix with the most keys.
	 */
	topPrefix: string | null;
	/** What couldn't be read. The rest of the repo's facts still stand. */
	errors: string[];
};

export type ScanResult = {
	version: 1;
	scannedAt: string;
	workdir: string;
	depth: number;
	repos: RepoScan[];
	/** Repo names more than one checkout has. State is keyed by name. */
	nameClashes: Array<{name: string; paths: string[]}>;
	skipped: {
		counts: Partial<Record<SkipReason, number>>;
		entries: Array<{path: string; reason: SkipReason}>;
	};
	prefixes: Record<string, PrefixSummary>;
	/** Prefixes found in commit subjects only, so taken for prose. */
	droppedPrefixes: Record<string, PrefixCounts>;
};

export type ScanOptions = {
	depth?: number;
	/** For git and gh: their PATH, and gh's login. */
	env?: NodeJS.ProcessEnv;
	now?: Date;
	commandTimeoutMs?: number;
};

type Run = (command: string, args: string[]) => Promise<string>;

function commandFailure(error: unknown): string {
	const failure = error as {
		killed?: boolean;
		code?: unknown;
		stderr?: string;
		message?: string;
	};
	if (failure.code === 'ENOENT') return 'not installed';
	if (failure.killed) return 'timed out';
	const stderr = failure.stderr?.trim().split('\n')[0];
	return stderr || failure.message || String(error);
}

function readRepoFiles(repo: string): RepoFiles {
	const has = (name: string) => fs.existsSync(path.join(repo, name));
	let readme: string | null = null;
	try {
		readme =
			fs
				.readdirSync(repo)
				.sort()
				.find(name => /^readme(\.[a-z]+)?$/i.test(name)) ?? null;
	} catch {
		// Reported by the git commands, which fail on the same directory.
	}

	return {
		'.pappardelle.yml': has(PROJECT_CONFIG_NAME),
		'CLAUDE.md': has('CLAUDE.md'),
		'AGENTS.md': has('AGENTS.md'),
		readme,
	};
}

/**
 * A branch per name, since a remote's copy of a local branch is the same
 * branch, and which of the names are local branches.
 */
function branchNames(refs: readonly string[]): {
	all: string[];
	local: string[];
} {
	const all = new Set<string>();
	const local: string[] = [];
	for (const ref of refs) {
		const localName = /^refs\/heads\/(.+)$/.exec(ref)?.[1];
		const remoteName = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1];
		if (localName) {
			all.add(localName);
			local.push(localName);
		} else if (remoteName && remoteName !== 'HEAD') {
			all.add(remoteName);
		}
	}

	return {all: [...all], local};
}

type RawRepoScan = Omit<RepoScan, 'tickets' | 'topPrefix'> & {
	read: RepoScan['tickets']['read'];
	prsSkipped?: string;
	evidence: Record<string, PrefixEvidence>;
};

type RepoScanContext = {
	workdir: string;
	run: Run;
	ghInstalled: boolean;
	/** Commits older than this aren't read. */
	since: Date;
};

async function scanRepo(
	repo: string,
	{workdir, run, ghInstalled, since}: RepoScanContext,
): Promise<RawRepoScan> {
	const errors: string[] = [];
	const git = async (...args: string[]) => run('git', ['-C', repo, ...args]);
	/** A git command's output as a list, or none when it fails. */
	const list = async (
		what: string,
		separator: string,
		...args: string[]
	): Promise<string[]> => {
		try {
			const output = await git(...args);
			return output.split(separator).filter(Boolean);
		} catch (error) {
			errors.push(`${what}: ${commandFailure(error)}`);
			return [];
		}
	};

	let originUrl: string | null = null;
	try {
		const url = await git('config', '--get', 'remote.origin.url');
		originUrl = url.trim();
	} catch (error) {
		// git config exits 1 when the key is unset: a repo with no origin.
		if ((error as {code?: unknown}).code !== 1)
			errors.push(`origin URL: ${commandFailure(error)}`);
	}

	const [refs, files, subjects] = await Promise.all([
		list(
			'branches',
			'\n',
			'for-each-ref',
			'--format=%(refname)',
			'refs/heads',
			'refs/remotes',
		),
		list('tracked files', '\0', 'ls-files', '-z'),
		// git stops at the first commit older than --since on each line of
		// history, which is what a window over recent work wants.
		list(
			'commits',
			'\n',
			'log',
			'--all',
			`--since=${since.toISOString()}`,
			'--format=%s',
		),
	]);

	let defaultBranch: string | null = null;
	let defaultBranchSource: RepoScan['defaultBranchSource'] = null;
	try {
		// Exits 1 when origin/HEAD was never set, as after `git remote add`.
		const head = await git(
			'symbolic-ref',
			'--quiet',
			'--short',
			'refs/remotes/origin/HEAD',
		);
		defaultBranch = head.trim().replace(/^origin\//, '');
		defaultBranchSource = 'origin/HEAD';
	} catch {
		const fallback = [
			'refs/remotes/origin/main',
			'refs/remotes/origin/master',
			'refs/heads/main',
			'refs/heads/master',
		].find(ref => refs.includes(ref));
		if (fallback) {
			defaultBranch = path.basename(fallback);
			defaultBranchSource = 'fallback';
		}
	}

	const github = originUrl ? remoteProject(originUrl, 'github.com') : null;
	let prs: PullRequestText[] | null = null;
	let prsSkipped: string | undefined;
	if (!github) {
		prsSkipped = originUrl
			? 'origin is not on github.com'
			: 'the repo has no origin';
	} else if (ghInstalled) {
		try {
			const listed: unknown = JSON.parse(
				await run('gh', [
					'pr',
					'list',
					'--repo',
					github,
					'--state',
					'all',
					'--limit',
					String(PR_LIMIT),
					'--json',
					'title,body,headRefName',
				]),
			);
			if (!Array.isArray(listed)) throw new Error('gh printed no list');
			prs = listed as PullRequestText[];
		} catch (error) {
			prsSkipped = `gh pr list failed: ${commandFailure(error)}`;
			errors.push(prsSkipped);
		}
	} else {
		prsSkipped = 'gh is not installed';
	}

	const branches = branchNames(refs);
	return {
		name: path.basename(repo),
		path: repo,
		relativePath: path.relative(workdir, repo) || '.',
		originUrl,
		github,
		defaultBranch,
		defaultBranchSource,
		languages: topLanguages(files),
		files: readRepoFiles(repo),
		read: {
			branches: branches.all.length,
			commits: subjects.length,
			prs: prs?.length ?? null,
		},
		...(prsSkipped === undefined ? {} : {prsSkipped}),
		evidence: collectTicketEvidence({
			branches: branches.all,
			localBranches: branches.local,
			commits: subjects,
			prs: prs ?? [],
		}),
		errors,
	};
}

const EXAMPLE_KEYS = 5;

/**
 * The keys named most often, the higher number first among equals: a key
 * named once can be a typo, and setup looks these up in the tracker.
 */
function exampleKeys(mentions: Record<string, number>): string[] {
	const number = (key: string) => Number(key.slice(key.lastIndexOf('-') + 1));
	return Object.entries(mentions)
		.sort((a, b) => b[1] - a[1] || number(b[0]) - number(a[0]))
		.slice(0, EXAMPLE_KEYS)
		.map(([key]) => key);
}

/**
 * Scan the work dir at `workdir`. One repo's failure, or gh's, is recorded
 * on that repo and the scan goes on.
 */
export async function scanWorkdir(
	workdir: string,
	options: ScanOptions = {},
): Promise<ScanResult> {
	const env = options.env ?? process.env;
	const now = options.now ?? new Date();
	const depth = options.depth ?? DEFAULT_DEPTH;
	const timeout = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
	const run: Run = async (command, args) => {
		const {stdout} = await execFileAsync(command, args, {
			cwd: workdir,
			env,
			encoding: 'utf8',
			timeout,
			maxBuffer: MAX_OUTPUT_BYTES,
		});
		return stdout;
	};

	const {checkouts, skipped} = findCheckouts(workdir, depth);
	const ghInstalled = Bun.which('gh', {PATH: env['PATH'] ?? ''}) !== null;
	const since = new Date(now.getTime() - COMMIT_WINDOW_DAYS * 86_400_000);
	const scanned = await pLimit(
		checkouts.map(repo => async (): Promise<RawRepoScan> => {
			try {
				return await scanRepo(repo, {workdir, run, ghInstalled, since});
			} catch (error) {
				return {
					name: path.basename(repo),
					path: repo,
					relativePath: path.relative(workdir, repo) || '.',
					originUrl: null,
					github: null,
					defaultBranch: null,
					defaultBranchSource: null,
					languages: [],
					files: readRepoFiles(repo),
					read: {branches: 0, commits: 0, prs: null},
					evidence: {},
					errors: [error instanceof Error ? error.message : String(error)],
				};
			}
		}),
		REPO_CONCURRENCY,
	);
	const raw = scanned.filter(repo => repo !== undefined);

	const {prefixes, dropped} = buildPrefixMap(raw);
	const repos = raw.map(({evidence, read, prsSkipped, ...repo}): RepoScan => {
		const kept = Object.entries(evidence)
			.filter(([prefix]) => Object.hasOwn(prefixes, prefix))
			.map(([prefix, found]) => ({prefix, found, counts: countsOf(found)}))
			.sort(
				(a, b) =>
					b.counts.keys - a.counts.keys || a.prefix.localeCompare(b.prefix),
			);
		const own = kept
			.filter(({counts}) => counts.localKeys >= MIN_LOCAL_KEYS)
			.sort((a, b) => b.counts.localKeys - a.counts.localKeys)[0];
		return {
			...repo,
			tickets: {
				read,
				...(prsSkipped === undefined ? {} : {prsSkipped}),
				prefixes: Object.fromEntries(
					kept.map(({prefix, found, counts}) => [
						prefix,
						{...counts, examples: exampleKeys(found.keys)},
					]),
				),
			},
			topPrefix: (own ?? kept[0])?.prefix ?? null,
		};
	});

	const pathsByName = new Map<string, string[]>();
	for (const repo of repos) {
		pathsByName.set(repo.name, [
			...(pathsByName.get(repo.name) ?? []),
			repo.path,
		]);
	}

	const counts: Partial<Record<SkipReason, number>> = {};
	for (const {reason} of skipped) counts[reason] = (counts[reason] ?? 0) + 1;

	return {
		version: 1,
		scannedAt: now.toISOString(),
		workdir,
		depth,
		repos,
		nameClashes: [...pathsByName]
			.filter(([, paths]) => paths.length > 1)
			.map(([name, paths]) => ({name, paths})),
		skipped: {
			counts,
			entries: skipped.map(({path: skippedPath, reason}) => ({
				path: path.relative(workdir, skippedPath) || '.',
				reason,
			})),
		},
		prefixes,
		droppedPrefixes: dropped,
	};
}

// ============================================================================
// Output
// ============================================================================

function table(rows: string[][]): string {
	const widths: number[] = [];
	for (const row of rows) {
		for (const [index, cell] of row.entries())
			widths[index] = Math.max(widths[index] ?? 0, cell.length);
	}

	return rows
		.map(row =>
			row
				.map((cell, index) =>
					index === row.length - 1 ? cell : cell.padEnd(widths[index]!),
				)
				.join('  ')
				.trimEnd(),
		)
		.join('\n');
}

const TABLE_PREFIXES = 4;
const TABLE_REPOS = 4;
const TABLE_DROPPED = 12;

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The scan as the table `lasagna scan` prints. */
export function formatScan(scan: ScanResult): string {
	const lines = [
		`${scan.workdir}: ${plural(scan.repos.length, 'repo')} (depth ${scan.depth})`,
	];
	if (scan.repos.length > 0) {
		lines.push(
			'',
			table([
				['REPO', 'BRANCH', 'LANGUAGES', 'HAS', 'TICKET KEYS'],
				...scan.repos.map(repo => {
					const prefixes = Object.entries(repo.tickets.prefixes);
					const more = prefixes.length - TABLE_PREFIXES;
					return [
						repo.relativePath,
						repo.defaultBranch ?? '-',
						repo.languages
							.map(
								({language, share}) =>
									`${language} ${Math.round(share * 100)}%`,
							)
							.join(', ') || '-',
						[
							...(
								['.pappardelle.yml', 'CLAUDE.md', 'AGENTS.md'] as const
							).filter(name => repo.files[name]),
							...(repo.files.readme ? ['README'] : []),
						].join(' ') || '-',
						prefixes
							.slice(0, TABLE_PREFIXES)
							.map(([prefix, {keys}]) => `${prefix} ${keys}`)
							.join(', ') + (more > 0 ? ` (+${more})` : '') || '-',
					];
				}),
			]),
		);
	}

	const prefixes = Object.entries(scan.prefixes);
	if (prefixes.length > 0) {
		const shareList = (repoShares: Record<string, number> | undefined) => {
			const repos = Object.entries(repoShares ?? {});
			const more = repos.length - TABLE_REPOS;
			return (
				repos
					.slice(0, TABLE_REPOS)
					.map(([repo, share]) => `${repo} ${share.toFixed(2)}`)
					.join(', ') + (more > 0 ? ` (+${more})` : '') || '-'
			);
		};

		lines.push(
			'',
			'Ticket prefixes. The default repo is where your local branches with the prefix are (3 keys or more), else the largest share of its keys.',
			table([
				[
					'PREFIX',
					'KEYS',
					'DEFAULT REPO',
					'SHARE OF KEYS',
					'IN LOCAL BRANCHES',
				],
				...prefixes.map(([prefix, summary]) => [
					prefix,
					String(summary.keys),
					summary.defaultRepo,
					shareList(summary.repos),
					shareList(summary.localRepos),
				]),
			]),
		);
	}

	const dropped = Object.entries(scan.droppedPrefixes)
		.map(([prefix, {commits, prs}]) => ({prefix, mentions: commits + prs}))
		.sort((a, b) => b.mentions - a.mentions);
	if (dropped.length > 0) {
		const more = dropped.length - TABLE_DROPPED;
		lines.push(
			'',
			`Dropped, in no branch name and opening no PR title: ${dropped
				.slice(0, TABLE_DROPPED)
				.map(({prefix, mentions}) => `${prefix} ${mentions}`)
				.join(', ')}${more > 0 ? ` (+${more})` : ''}`,
		);
	}

	const skips = Object.entries(scan.skipped.counts) as Array<
		[SkipReason, number]
	>;
	if (skips.length > 0) {
		lines.push(
			'',
			`Skipped: ${skips
				.map(
					([reason, count]) =>
						`${count} ${SKIP_REASON_LABELS[reason][count === 1 ? 0 : 1]}`,
				)
				.join(', ')}`,
		);
	}

	for (const {name, paths} of scan.nameClashes) {
		lines.push(
			'',
			`Name clash: ${paths.length} repos are named ${name}, and state is kept by name: ${paths.join(', ')}`,
		);
	}

	const withoutPrs = scan.repos.filter(repo => repo.tickets.prsSkipped);
	const failed = scan.repos.filter(repo => repo.errors.length > 0);
	if (withoutPrs.length > 0) {
		lines.push(
			'',
			'PRs not read:',
			...withoutPrs.map(
				repo => `  ${repo.relativePath}: ${repo.tickets.prsSkipped}`,
			),
		);
	}

	if (failed.length > 0) {
		lines.push(
			'',
			'Errors:',
			...failed.flatMap(repo =>
				repo.errors.map(error => `  ${repo.relativePath}: ${error}`),
			),
		);
	}

	return lines.join('\n');
}

// ============================================================================
// The command
// ============================================================================

export type ScanCommandDeps = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	out: (text: string) => void;
	err: (text: string) => void;
	now?: () => Date;
};

/**
 * The directory a work dir command runs on: the one named, else the nearest
 * work dir above the working directory, else the working directory.
 */
export function resolveWorkdirArgument(
	argument: string | undefined,
	cwd: string,
	env: NodeJS.ProcessEnv,
): string {
	return argument === undefined
		? (findWorkdir(cwd, env) ?? cwd)
		: path.resolve(cwd, argument);
}

/** Write the scan to `<workdir>/.lasagna/scan.json`, and return that path. */
export function writeScan(scan: ScanResult): string {
	const file = path.join(scan.workdir, WORKDIR_SCAN_FILE);
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(file, `${JSON.stringify(scan, null, 2)}\n`);
	return file;
}

/** Exit codes: 0 scanned, 1 the directory or scan.json failed, 2 usage. */
export async function runScanCommand(
	argv: string[],
	deps: ScanCommandDeps,
): Promise<number> {
	if (argv.some(arg => arg === '--help' || arg === '-h')) {
		deps.out(SCAN_HELP);
		return 0;
	}

	const usage = (message: string) => {
		deps.err(`${message}\n${SCAN_USAGE}`);
		return 2;
	};

	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				depth: {type: 'string'},
				json: {type: 'boolean'},
				'dry-run': {type: 'boolean'},
			},
		});
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error));
	}

	const {values, positionals} = parsed;
	if (positionals.length > 1) return usage('scan takes one directory');
	const depth =
		values.depth === undefined ? DEFAULT_DEPTH : Number(values.depth);
	if (!Number.isInteger(depth) || depth < 0)
		return usage('--depth needs a whole number, 0 or more');

	const workdir = resolveWorkdirArgument(positionals[0], deps.cwd, deps.env);
	if (!fs.statSync(workdir, {throwIfNoEntry: false})?.isDirectory()) {
		deps.err(`${workdir} is not a directory`);
		return 1;
	}

	const scan = await scanWorkdir(fs.realpathSync(workdir), {
		depth,
		env: deps.env,
		now: deps.now?.(),
	});
	let written: string | undefined;
	if (!values['dry-run']) {
		try {
			written = writeScan(scan);
		} catch (error) {
			deps.err(
				`Could not write ${path.join(scan.workdir, WORKDIR_SCAN_FILE)}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return 1;
		}
	}

	if (values.json) {
		deps.out(JSON.stringify(scan, null, 2));
	} else {
		deps.out(formatScan(scan));
		deps.out(
			written ? `\nWrote ${written}` : '\nDry run: scan.json not written',
		);
	}

	return 0;
}

export function defaultScanCommandDeps(): ScanCommandDeps {
	return {
		cwd: process.cwd(),
		env: process.env,
		out: text => console.log(text),
		err: text => console.error(text),
	};
}
