// `lasagna setup [dir]`: learn each repo's defaults and, once approved,
// write them as `repos.<name>.inferred` in the workdir config. It runs scan,
// asks a headless Claude which Jira tools it has, then runs one headless
// Claude per repo to read the repo's docs and check the scan's ticket
// prefixes against Jira. Nothing but `inferred` is ever rewritten.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {parseArgs} from 'node:util';
import {Document, isMap, parse, parseDocument, stringify} from 'yaml';
import {
	getDefaultHomeConfigDir,
	layerOf,
	loadRawMergedConfig,
	readConfigLayers,
	type ConfigPaths,
} from '../config.ts';
import {ConfigNotFoundError, ConfigValidationError} from '../config-errors.ts';
import {pLimit} from '../providers/concurrency.ts';
import {
	KEY_SPECS,
	keyFor,
	isRecord,
	keyOf,
	mergeValues,
	parseRepoAnswer,
	type Confidence,
	type InferredValue,
} from './answer.ts';
import {
	PROJECT_CONFIG_NAME,
	WORKDIR_CONFIG_FILE,
} from '../repo-config-files.ts';
import {
	WORKDIR_SCAN_FILE,
	resolveWorkdirArgument,
	scanWorkdir,
	writeScan,
	type RepoScan,
	type ScanResult,
} from '../workdir-scan.ts';

export const SETUP_USAGE =
	'Usage: lasagna setup [dir] [--repo <name>] [--no-claude] [--yes] [--dry-run] [--model <model>] [--depth N]';

export const SETUP_HELP = `
	Usage
	  $ lasagna setup [dir] [--repo <name>] [--no-claude] [--yes]
	                      [--dry-run] [--model <model>] [--depth N]

	Learns each repo's defaults in a work dir and writes them, once you
	approve, to <dir>/.lasagna/workdir.yml as repos.<name>.inferred. dir
	defaults as for lasagna scan.

	It runs scan first. Then one short claude -p reports which Jira tools
	Claude has: the Atlassian tools, else acli, else none. Then one claude -p
	per repo, four at a time, reads the repo's CLAUDE.md, AGENTS.md and README
	and checks the scan's ticket prefixes against Jira. Each starts in an
	empty scratch directory with the repo added read-only, so the repo's own
	Claude hooks don't run, and may only read files and Jira.

	What it works out, as config keys: team_prefix, issue_tracker (provider,
	base_url, default_issue_type), post_workspace_init commands for a fresh
	worktree, and on the repo's profile tracker_projects, keywords,
	display_name, vcs.label and the vars PR_TEMPLATE and PR_TITLE_FORMAT.
	Every value carries where it came from and a confidence.

	Then it prints what would change for each repo and asks: accept all, go
	repo by repo, edit the file first, or quit. Only inferred is rewritten:
	settings you add beside it, your comments and a repo's own
	.pappardelle.yml stay, and win over what was inferred. A repo whose answer
	is invalid, or whose merged config would not validate, is reported and
	left as it was.

	Options
	  --repo <name>    Learn one repo only
	  --no-claude      Run no Claude: write defaults from the scan alone
	  --yes            Don't ask: accept the high-confidence values only
	  --dry-run        Print the proposal and write nothing, scan.json included
	  --model <model>  Passed to claude as --model
	  --depth N        As for scan

	Exit codes
	  0  Done, or nothing to change, or you declined
	  1  The directory, claude or workdir.yml failed
	  2  Usage
	  3  One or more repos were reported and left as they were
`;

const REPO_CONCURRENCY = 4;
const REPO_TIMEOUT_MS = 10 * 60_000;
const TOOL_CHECK_TIMEOUT_MS = 2 * 60_000;
const KILL_GRACE_MS = 5000;

// ============================================================================
// What setup may infer
// ============================================================================

function profileNameFor(repoName: string): string {
	return repoName.replaceAll(/[^\w-]/g, '-');
}

export type OwnConfig = {file: string; config: Record<string, unknown>};

/** The repo's own committed config, when it has one that parses. */
function readOwnConfig(repo: RepoScan): OwnConfig | undefined {
	const file = path.join(repo.path, PROJECT_CONFIG_NAME);
	if (!fs.existsSync(file)) return undefined;
	try {
		const config: unknown = parse(fs.readFileSync(file, 'utf8'));
		return {file: path.basename(file), config: isRecord(config) ? config : {}};
	} catch {
		// Its errors are reported when the merged config is checked.
		return {file: path.basename(file), config: {}};
	}
}

/**
 * The profile inferred profile settings go on: the repo's own default
 * profile when its config has profiles, so nothing adds a second profile to
 * a repo that chose its own; else one named after the repo.
 */
function profileFor(repo: RepoScan, own: OwnConfig | undefined): string {
	const profiles = own?.config['profiles'];
	if (isRecord(profiles)) {
		const chosen = own?.config['default_profile'];
		if (typeof chosen === 'string' && Object.hasOwn(profiles, chosen))
			return chosen;
		const first = Object.keys(profiles)[0];
		if (first) return first;
	}

	return profileNameFor(repo.name);
}

/**
 * What the scan alone says about a repo: the top ticket prefix and the Jira
 * site from JIRA_BASE_URL. It also fills in what a config can't do without
 * and the repo's own config doesn't give: the version, and the profile the
 * inferred profile settings go on.
 */
export function scanDefaults(
	repo: RepoScan,
	profile: string,
	own: OwnConfig | undefined,
	env: NodeJS.ProcessEnv,
): InferredValue[] {
	const values: InferredValue[] = [];
	const scaffold = {
		source: 'setup: a config needs a version and one profile',
		confidence: 'high',
	} as const;
	if (!own) values.push({path: ['version'], value: 1, ...scaffold});
	const profiles = own?.config['profiles'];
	if (!isRecord(profiles) || !Object.hasOwn(profiles, profile)) {
		values.push(
			{path: ['default_profile'], value: profile, ...scaffold},
			{
				path: ['profiles', profile, 'display_name'],
				value: repo.name,
				...scaffold,
			},
		);
	}

	const prefixes = Object.entries(repo.tickets.prefixes);
	const top = repo.topPrefix
		? repo.tickets.prefixes[repo.topPrefix]
		: undefined;
	if (repo.topPrefix && top) {
		const allKeys = prefixes.reduce((sum, [, {keys}]) => sum + keys, 0);
		const share = top.keys / allKeys;
		const local =
			top.localKeys > 0 ? `, ${top.localKeys} in local branches` : '';
		values.push({
			path: ['team_prefix'],
			value: repo.topPrefix,
			source: `scan: ${top.keys} of the repo's ${allKeys} ticket keys are ${repo.topPrefix}${local}`,
			// Nearly all of a repo's tickets, or the prefix of the local
			// branches, is a strong sign; a plurality among many is not.
			confidence:
				share >= 0.75 && top.keys >= 5
					? 'high'
					: share >= 0.5 || top.localKeys >= 3
						? 'medium'
						: 'low',
		});
	}

	const jira = env['JIRA_BASE_URL']?.trim().replace(/\/+$/, '');
	if (jira && prefixes.length > 0) {
		const found = {
			source: 'JIRA_BASE_URL in the environment',
			confidence: 'medium',
		} as const;
		values.push(
			{path: ['issue_tracker', 'provider'], value: 'jira', ...found},
			{path: ['issue_tracker', 'base_url'], value: jira, ...found},
		);
	}

	if (repo.originUrl && /gitlab/i.test(repo.originUrl) && !repo.github) {
		values.push({
			path: ['vcs_host', 'provider'],
			value: 'gitlab',
			source: `scan: origin is ${repo.originUrl}`,
			confidence: 'high',
		});
	}

	return values;
}

// ============================================================================
// Headless Claude
// ============================================================================

export type ClaudeRun = {
	durationMs: number;
	costUsd?: number;
	turns?: number;
	model?: string;
	/** The tools Claude named: the ones it started with, and any a tool search returned. */
	toolNames: string[];
	/** The MCP servers Claude listed as it started, each with its status then. */
	mcpServers: Array<{name: string; status: string}>;
	/** The tools whose calls were refused, one entry per call. */
	denied: string[];
} & ({ok: true; result: string} | {ok: false; error: string});

type ClaudeRequest = {
	prompt: string;
	/** The built-in tools Claude gets at all. */
	tools: string[];
	/**
	 * Permission rules for what it may use without being asked. Anything else
	 * is refused, except reading inside `addDir`, which needs no rule.
	 */
	allowedTools?: string[];
	/** Tools refused whatever the user's own settings allow. */
	disallowedTools?: string[];
	addDir?: string;
	model?: string;
	timeoutMs: number;
	env: NodeJS.ProcessEnv;
};

/** A space's identity must not reach a Claude that isn't that space's agent. */
const SPACE_ENV = new Set([
	'LASAGNA_SPACE',
	'LASAGNA_REPO',
	'LASAGNA_MAIN_REPO_ROOT',
]);

type ClaudeStream = {
	toolNames: Set<string>;
	mcpServers: Array<{name: string; status: string}>;
	result?: Record<string, unknown>;
};

function listOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * Take what setup needs from one line of claude's stream-json output.
 * False when the line is not an event at all.
 */
function readStreamEvent(text: string, stream: ClaudeStream): boolean {
	let event: unknown;
	try {
		event = JSON.parse(text);
	} catch {
		return false;
	}

	if (!isRecord(event)) return false;
	if (event['type'] === 'result') {
		stream.result = event;
		return true;
	}

	if (event['type'] === 'system' && event['subtype'] === 'init') {
		for (const name of listOf(event['tools']))
			if (typeof name === 'string') stream.toolNames.add(name);
		for (const server of listOf(event['mcp_servers'])) {
			if (isRecord(server) && typeof server['name'] === 'string') {
				stream.mcpServers.push({
					name: server['name'],
					status: typeof server['status'] === 'string' ? server['status'] : '',
				});
			}
		}

		return true;
	}

	// A tool search answers with references to the tools it found.
	if (event['type'] !== 'user' || !isRecord(event['message'])) return true;
	for (const block of listOf(event['message']['content'])) {
		if (!isRecord(block) || block['type'] !== 'tool_result') continue;
		for (const item of listOf(block['content'])) {
			if (
				isRecord(item) &&
				item['type'] === 'tool_reference' &&
				typeof item['tool_name'] === 'string'
			)
				stream.toolNames.add(item['tool_name']);
		}
	}

	return true;
}

/** How much of what claude printed outside its events is kept for an error. */
const STRAY_OUTPUT_CHARS = 2000;

/**
 * Run `claude -p` in an empty scratch directory and return its answer. It
 * never starts inside a repo, where headless Claude would run the repo's
 * `.claude` hooks without asking; the repo is added with --add-dir instead,
 * which lets Claude read inside it and loads none of its settings.
 *
 * The output is read as a stream of events rather than one result, for the
 * tools and MCP servers Claude names on the way.
 */
/**
 * A scratch directory for one headless Claude, under the home directory:
 * Claude loads no CLAUDE.md at all when started under /private/tmp.
 */
export function makeScratch(
	root = path.join(os.homedir(), '.cache', 'lasagna-setup'),
): string {
	fs.mkdirSync(root, {recursive: true});
	return fs.mkdtempSync(path.join(root, 'run-'));
}

export async function runClaude(request: ClaudeRequest): Promise<ClaudeRun> {
	const started = Date.now();
	const scratch = makeScratch(
		path.join(request.env['HOME'] ?? os.homedir(), '.cache', 'lasagna-setup'),
	);
	const env = {
		...Object.fromEntries(
			Object.entries(request.env).filter(([name]) => !SPACE_ENV.has(name)),
		),
		// Without it, a repo added with --add-dir brings its skills but not its
		// CLAUDE.md (tested 2026-11-25).
		CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
	};
	// Each rule is an argument of its own: a rule can hold spaces and commas.
	const rules = (flag: string, list: string[] | undefined) =>
		list && list.length > 0 ? [flag, ...list] : [];
	const child = spawn(
		'claude',
		[
			'-p',
			'--output-format',
			'stream-json',
			'--verbose',
			'--no-session-persistence',
			// Anything not allowed is refused instead of asked about.
			'--permission-mode',
			'dontAsk',
			'--tools',
			request.tools.join(','),
			...rules('--allowedTools', request.allowedTools),
			...rules('--disallowedTools', request.disallowedTools),
			...(request.addDir ? ['--add-dir', request.addDir] : []),
			...(request.model ? ['--model', request.model] : []),
		],
		{cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe']},
	);
	const stream: ClaudeStream = {toolNames: new Set(), mcpServers: []};
	let unread = '';
	let stray = '';
	let stderr = '';
	// What claude prints that is no event is kept to explain a failure.
	const readLine = (text: string) => {
		if (text.trim() && !readStreamEvent(text, stream))
			stray = `${stray}${text}\n`.slice(-STRAY_OUTPUT_CHARS);
	};

	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		const lines = (unread + chunk).split('\n');
		unread = lines.pop()!;
		for (const text of lines) readLine(text);
	});
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		stderr = (stderr + chunk).slice(-STRAY_OUTPUT_CHARS);
	});
	// A claude that exits early closes its stdin under the write.
	child.stdin.on('error', () => undefined);
	child.stdin.end(request.prompt);

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill('SIGTERM');
		setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
	}, request.timeoutMs);
	const exit = await new Promise<number | string>(resolve => {
		child.on('error', error => {
			resolve(
				(error as NodeJS.ErrnoException).code === 'ENOENT'
					? 'claude was not found on PATH'
					: error.message,
			);
		});
		child.on('close', (code, signal) => {
			resolve(code ?? `killed by ${signal}`);
		});
	});
	clearTimeout(timer);
	readLine(unread);
	fs.rmSync(scratch, {recursive: true, force: true});

	const report = stream.result ?? {};
	const models = isRecord(report['modelUsage'])
		? Object.keys(report['modelUsage']).join(', ')
		: '';
	const facts = {
		durationMs: Date.now() - started,
		...(typeof report['total_cost_usd'] === 'number'
			? {costUsd: report['total_cost_usd']}
			: {}),
		...(typeof report['num_turns'] === 'number'
			? {turns: report['num_turns']}
			: {}),
		...(models ? {model: models} : {}),
		toolNames: [...stream.toolNames],
		mcpServers: stream.mcpServers,
		denied: listOf(report['permission_denials']).flatMap(denial =>
			isRecord(denial) && typeof denial['tool_name'] === 'string'
				? [denial['tool_name']]
				: [],
		),
	};
	if (timedOut) {
		return {
			ok: false,
			...facts,
			error: `timed out after ${seconds(request.timeoutMs)}`,
		};
	}

	if (
		exit === 0 &&
		report['is_error'] !== true &&
		typeof report['result'] === 'string'
	)
		return {ok: true, result: report['result'], ...facts};
	const said =
		typeof report['result'] === 'string' && report['result']
			? report['result']
			: stderr.trim() || stray.trim();
	return {
		ok: false,
		...facts,
		error: [
			typeof exit === 'string' ? exit : `claude exited with ${exit}`,
			said.split('\n')[0]?.slice(0, 300),
		]
			.filter(Boolean)
			.join(': '),
	};
}

/** How a per-repo run can read Jira. */
export type JiraAccess =
	| {
			kind: 'tools';
			/** The tools that only read. */
			tools: string[];
			/** Claude's other Jira and Atlassian tools, which the runs are refused. */
			otherTools: string[];
	  }
	| {kind: 'acli'}
	| {kind: 'none'; why: string};

// The Atlassian tools that only read, by the last part of their name. A
// tool that isn't here is never allowed, so a new write tool can't slip in.
const JIRA_READ_TOOLS = new Set([
	'getJiraIssue',
	'searchJiraIssuesUsingJql',
	'getAccessibleAtlassianResources',
	'getVisibleJiraProjects',
	'getJiraProjectIssueTypesMetadata',
	'getJiraIssueRemoteIssueLinks',
	'discover',
	'executeRead',
	'getGraphContext',
	'getGraphObject',
]);
const JIRA_LOOKUP_TOOLS = new Set(['getJiraIssue', 'searchJiraIssuesUsingJql']);
const JIRA_NAME = /atlassian|jira/i;

const TOOL_CHECK_PROMPT = `Which Jira tools do you have? First run your tool search (the ToolSearch tool) with the query "jira issue", so that tools from servers that are still connecting are found too. Then reply with one JSON object and nothing else: {"jira_tools": ["..."]}, listing the exact name of every tool available to you, loaded or deferred, whose name contains "Atlassian" or "Jira" in any letter case. Use an empty list when there are none.`;

/**
 * The Jira and Atlassian MCP tools among `names`: the ones that only read,
 * and the rest. No read tools at all when none of them looks an issue up,
 * since there is nothing to confirm a prefix with then.
 */
export function jiraTools(names: Iterable<string>): {
	read: string[];
	other: string[];
} {
	const jira = [...new Set(names)]
		.filter(name => name.startsWith('mcp__') && JIRA_NAME.test(name))
		.sort();
	const base = (name: string) => name.slice(name.lastIndexOf('__') + 2);
	const read = jira.filter(name => JIRA_READ_TOOLS.has(base(name)));
	const other = jira.filter(name => !JIRA_READ_TOOLS.has(base(name)));
	return read.some(name => JIRA_LOOKUP_TOOLS.has(base(name)))
		? {read, other}
		: {read: [], other: jira};
}

async function succeeds(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<boolean> {
	return new Promise(resolve => {
		const child = spawn(command, args, {env, stdio: 'ignore', timeout: 15_000});
		child.on('error', () => {
			resolve(false);
		});
		child.on('close', code => {
			resolve(code === 0);
		});
	});
}

/**
 * Claude's connectors connect while it starts, and a question it answers
 * before they have is answered without them. So a check that finds no Jira
 * tools while Claude lists a Jira server as still connecting is asked again.
 */
const TOOL_CHECK_ATTEMPTS = 3;

/**
 * Ask Claude which Jira tools it has. claude.ai connectors exist only when
 * Claude runs under a login (an API key turns them off), so this is asked,
 * not assumed. Without them acli is the fallback, when it is logged in.
 */
export async function checkJiraAccess(options: {
	env: NodeJS.ProcessEnv;
	model?: string;
	timeoutMs: number;
}): Promise<{access: JiraAccess; runs: ClaudeRun[]}> {
	const runs: ClaudeRun[] = [];
	for (let attempt = 1; attempt <= TOOL_CHECK_ATTEMPTS; attempt++) {
		// eslint-disable-next-line no-await-in-loop -- Asked again only after an answer.
		const run = await runClaude({
			prompt: TOOL_CHECK_PROMPT,
			tools: ['ToolSearch'],
			allowedTools: ['ToolSearch'],
			model: options.model,
			timeoutMs: options.timeoutMs,
			env: options.env,
		});
		runs.push(run);
		if (!run.ok) return {access: {kind: 'none', why: run.error}, runs};
		// The names Claude was given are exact; the ones in its answer are
		// its own account of the tools still deferred.
		const found = jiraTools([
			...run.toolNames,
			...(run.result.match(/[\w.:-]+/g) ?? []),
		]);
		if (found.read.length > 0) {
			return {
				access: {kind: 'tools', tools: found.read, otherTools: found.other},
				runs,
			};
		}

		const connecting = run.mcpServers.some(
			({name, status}) => JIRA_NAME.test(name) && status === 'pending',
		);
		if (found.other.length > 0 || !connecting) break;
	}

	if (Bun.which('acli', {PATH: options.env['PATH'] ?? ''}) === null) {
		return {
			access: {
				kind: 'none',
				why: 'Claude has no Atlassian tools and acli is not installed',
			},
			runs,
		};
	}

	return {
		access: (await succeeds('acli', ['jira', 'auth', 'status'], options.env))
			? {kind: 'acli'}
			: {
					kind: 'none',
					why: 'Claude has no Atlassian tools and acli is not logged in',
				},
		runs,
	};
}

const ACLI_COMMANDS = [
	'Bash(acli jira workitem view:*)',
	'Bash(acli jira workitem search:*)',
];

function describeJiraAccess(access: JiraAccess): string {
	switch (access.kind) {
		case 'tools': {
			return `Jira through Claude's Atlassian tools (${access.tools
				.map(name => name.slice(name.lastIndexOf('__') + 2))
				.join(', ')})`;
		}

		case 'acli': {
			return 'Jira through acli (Claude has no Atlassian tools)';
		}

		case 'none': {
			return `no Jira (${access.why}), so Jira projects come from the scan alone`;
		}
	}
}

function jiraInstructions(access: JiraAccess): string {
	switch (access.kind) {
		case 'tools': {
			return `You have these Jira tools, all read-only: ${access.tools.join(', ')}. One that you cannot call yet is deferred: load it with ToolSearch (query \`select:<name>,<name>\`) first. If a call needs a cloudId, get it from getAccessibleAtlassianResources. Every other Jira or Atlassian tool is refused.`;
		}

		case 'acli': {
			return 'Read Jira with the Bash tool, which may run only these two commands: `acli jira workitem view <KEY> --json` and `acli jira workitem search --jql "<JQL>" --json --limit 20`.';
		}

		case 'none': {
			return 'You have no access to Jira. Work from the scan and the repo alone, and give anything about Jira projects or issue types at most medium confidence.';
		}
	}
}

/** The scan's facts about a repo, as its Claude run is told them. */
function repoFacts(repo: RepoScan, scan: ScanResult): Record<string, unknown> {
	return {
		name: repo.name,
		path: repo.path,
		origin: repo.originUrl,
		github: repo.github,
		default_branch: repo.defaultBranch,
		languages: repo.languages.map(
			({language, share}) => `${language} ${Math.round(share * 100)}%`,
		),
		files_present: [
			...Object.entries(repo.files)
				.filter(([name, present]) => name !== 'readme' && present === true)
				.map(([name]) => name),
			...(repo.files.readme ? [repo.files.readme] : []),
		],
		ticket_prefixes: Object.entries(repo.tickets.prefixes)
			.slice(0, 10)
			.map(([prefix, counts]) => ({
				prefix,
				keys_in_this_repo: counts.keys,
				keys_in_local_branches: counts.localKeys,
				branches: counts.branches,
				commits_last_180_days: counts.commits,
				recent_prs: counts.prs,
				example_keys: counts.examples,
				share_of_the_prefix_across_the_work_dir:
					scan.prefixes[prefix]?.repos[repo.name],
				work_dir_default_repo_for_the_prefix:
					scan.prefixes[prefix]?.defaultRepo,
			})),
		prefix_of_most_local_branches: repo.topPrefix,
	};
}

/**
 * The work dir's own docs, which a repo's run may read besides the repo:
 * they hold what is true of every repo in it, such as the issue type a
 * project's tickets get. None when the work dir is the repo.
 */
export function workdirDocs(workdir: string, repo: RepoScan): string[] {
	if (path.resolve(workdir) === path.resolve(repo.path)) return [];
	return ['CLAUDE.md', 'AGENTS.md']
		.map(name => path.join(workdir, name))
		.filter(file => fs.statSync(file, {throwIfNoEntry: false})?.isFile());
}

/** The prompt for one repo's run. */
export function repoPrompt(
	repo: RepoScan,
	scan: ScanResult,
	profile: string,
	access: JiraAccess,
	docs: string[] = [],
): string {
	const keys = KEY_SPECS.map(
		spec => `- \`${keyFor(spec, profile)}\` (${spec.type}): ${spec.meaning}`,
	).join('\n');
	const outside =
		docs.length > 0
			? ` Outside the repo you may read only ${docs.join(' and ')}: the work dir's own notes, which cover every repo in it. Take from them what names this repo or its Jira projects.`
			: '';
	return `You are setting up Lasagna, a tool that opens one git worktree and one coding agent per ticket, for the repo \`${repo.name}\` at ${repo.path}. Work out the settings below from what the repo and the issue tracker say.

This is read-only work. Do not create, change or delete anything, in the repo or in the tracker.

## What a scan of the repo found

\`\`\`json
${JSON.stringify(repoFacts(repo, scan), null, 2)}
\`\`\`

Ticket keys were counted from branch names, the commit subjects of the last 180 days and the last 200 PRs. A prefix can still be noise.

## Where to look

In the repo, read only what answers the questions: CLAUDE.md, AGENTS.md, the README, CONTRIBUTING, the PR template under .github/, and the files those point at for setup (package.json scripts, a Makefile, mise.toml, .tool-versions, .env.example). Find them with Glob and Grep, giving the repo's path. Do not survey the source code. About fifteen file reads should be enough.${outside}

${jiraInstructions(access)}

## What to work out

1. Jira projects. The scan's prefixes are the candidates. Confirm which of them are Jira projects whose tickets are worked on in this repo. The best evidence is an issue whose development info (linked branches, pull requests, commits) names this repo${repo.github ? ` (${repo.github})` : ''}; next, a project whose name or components match what this repo is. Look up a few example keys per prefix, not all of them. An issue that comes back under another key was moved: the project it is in now is the real one. \`team_prefix\` is the one project new tickets for this repo belong in; prefer the project the local branches use when Jira confirms it. \`tracker_projects\` lists every confirmed project key, that one first. Leave out a prefix that is not a Jira project.
2. The issue type new tickets get.
3. The commands a fresh git worktree of this repo needs before work can start, for \`post_workspace_init\`. A shell runs them in order after the worktree is created. They may use \${WORKTREE_PATH} (the new worktree), \${MAIN_REPO_ROOT} (the main checkout, where untracked files such as .env live) and \${ISSUE_KEY}. Start a command that must run inside the worktree with \`cd \${WORKTREE_PATH} && \`. Copy an untracked file like this: \`cp -n \${MAIN_REPO_ROOT}/.env \${WORKTREE_PATH}/.env 2>/dev/null || true\`. Include only what the docs say a fresh checkout or worktree needs: installing dependencies, trusting tool-version files, copying untracked env files, code generation. Leave out builds, tests, servers and anything slow that work can start without. Set continue_on_error to true on a step whose failure should not stop the rest. .pappardelle.local.yml, .claude/settings.local.json and CLAUDE.local.md are copied already.
4. PR rules: where the PR template is, and the PR title format the docs give or recent titles follow.
5. Any other key below that the repo's docs settle.

## The keys you may set

${keys}

## Your answer

Reply with one JSON object and nothing else, no prose around it and no code fence:

{"values": [{"key": "team_prefix", "value": "ABC", "source": "Jira: ABC-12 and ABC-15 link pull requests in this repo", "confidence": "high"}], "notes": ["..."]}

- \`key\` is one of the keys above, spelled exactly. Any other key makes the whole answer unusable.
- \`source\` says where the value comes from, on one line and specifically: a file and line ("CLAUDE.md:42"), a Jira lookup ("Jira: PLAT-5757 is now AP-310 in project AP"), or a scan count ("scan: 113 keys in local branches are PLAT").
- \`confidence\` is "high" when a doc states it or Jira confirms it, "medium" when consistent evidence implies it, "low" when it is a guess.
- Leave out a key you found nothing for. Do not invent values.
- \`notes\` holds at most five short remarks a person should see, such as a prefix that is not a Jira project or tickets that were moved.`;
}

// ============================================================================
// Proposals
// ============================================================================

/** What setup proposes for one repo, or why it proposes nothing. */
export type RepoProposal = {
	repo: RepoScan;
	profile: string;
	/** The repo's own config file, whose settings win over inferred ones. */
	ownConfig?: string;
	/** What the scan alone says. */
	defaults: InferredValue[];
	/** What Claude worked out. A key here replaces the scan's. */
	learned: InferredValue[];
	notes: string[];
	/** Why the repo is left as it was. */
	problems: string[];
	run?: ClaudeRun;
};

function plural(count: number, noun: string, nouns = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : nouns}`;
}

/** Rows as left-aligned columns two spaces apart. */
function formatTable(rows: string[][]): string {
	const widths = rows[0]!.map((_, column) =>
		Math.max(...rows.map(row => (row[column] ?? '').length)),
	);
	return rows
		.map(row =>
			row
				.map((cell, column) =>
					column === row.length - 1 ? cell : cell.padEnd(widths[column]!),
				)
				.join('  '),
		)
		.join('\n');
}

/** Everything proposed for a repo: Claude's values over the scan's. */
export function proposedValues(proposal: RepoProposal): InferredValue[] {
	return mergeValues(proposal.defaults, proposal.learned);
}

const TRACKER = 'issue_tracker';
const TRACKER_PROVIDER = `${TRACKER}.provider`;
const TRACKER_BASE_URL = `${TRACKER}.base_url`;

/**
 * What `--yes` writes: for each key its high-confidence value, the scan's
 * when Claude's is weaker, so a repo keeps the profile name the scan gave it
 * when Claude only guessed a better one.
 *
 * The tracker's keys stand or fall with its provider. A base URL or an issue
 * type means nothing without one, and a jira provider is refused without its
 * base URL, so when a provider is proposed and it, or the URL jira needs, is
 * not high-confidence, none of them are written.
 */
export function highConfidenceValues(proposal: RepoProposal): {
	kept: InferredValue[];
	left: InferredValue[];
} {
	const sure = (values: InferredValue[]) =>
		values.filter(({confidence}) => confidence === 'high');
	const all = proposedValues(proposal);
	const high = mergeValues(sure(proposal.defaults), sure(proposal.learned));
	const find = (key: string) => high.find(value => keyOf(value) === key);
	const provider = find(TRACKER_PROVIDER);
	const trackerStands = all.some(value => keyOf(value) === TRACKER_PROVIDER)
		? provider !== undefined &&
			(provider.value !== 'jira' || find(TRACKER_BASE_URL) !== undefined)
		: true;
	const kept = high.filter(value => value.path[0] !== TRACKER || trackerStands);
	return {kept, left: all.filter(value => !kept.includes(value))};
}

/** `repos.<name>.inferred` for a set of values. */
export function inferredSection(values: InferredValue[]): {
	config: Record<string, unknown>;
	sources: Record<string, {source: string; confidence: Confidence}>;
} {
	const config: Record<string, unknown> = {};
	const sources: Record<string, {source: string; confidence: Confidence}> = {};
	for (const {path: keys, value, source, confidence} of values) {
		let node = config;
		for (const key of keys.slice(0, -1)) {
			node[key] ??= {};
			node = node[key] as Record<string, unknown>;
		}

		node[keys.at(-1)!] = value;
		sources[keys.join('.')] = {source, confidence};
	}

	return {config, sources};
}

// ============================================================================
// The workdir config file
// ============================================================================

const NEW_FILE_COMMENT = ` Lasagna's config for this work dir (see lasagna setup --help).
 Setup rewrites only each repo's \`inferred\` section. Put your own settings
 beside it, under repos.<name>, or at the top level for every repo: they win.`;

function parseWorkdirDocument(text: string | undefined): Document {
	if (text === undefined || !text.trim()) {
		const document = new Document({});
		document.commentBefore = NEW_FILE_COMMENT;
		return document;
	}

	return parseDocument(text);
}

/**
 * Give the work dir's own spaces (its root main space and ticket spaces)
 * the config every space needs, once: they read only the home config and
 * the file's top level, and with no profile there a ticket space is
 * refused. Added only when the top level has no profiles, and never
 * changed afterwards. `tracker` is the issue tracker every repo's proposal
 * agrees on, if any. Returns what was added.
 */
export function scaffoldTopLevel(
	document: Document,
	workdir: string,
	tracker?: Record<string, unknown>,
): string[] {
	if (!isMap(document.contents)) document.contents = document.createNode({});
	if (document.has('profiles')) return [];
	const added: string[] = [];
	if (!document.has('version')) {
		document.set('version', 1);
		added.push('version: 1');
	}

	const name = path.basename(workdir);
	document.set('profiles', document.createNode({work: {display_name: name}}));
	added.push(`profiles.work.display_name: ${JSON.stringify(name)}`);
	if (tracker && !document.has('issue_tracker')) {
		document.set('issue_tracker', document.createNode(tracker));
		added.push(`issue_tracker: ${JSON.stringify(tracker)}`);
	}

	const {contents} = document;
	if (isMap(contents)) {
		const pair = contents.items.find(
			item => isScalarKey(item.key) === 'profiles',
		);
		if (pair?.key && typeof pair.key === 'object')
			(pair.key as {commentBefore?: string}).commentBefore =
				" Written once by setup for the work dir's own spaces. Yours to edit.";
	}

	return added;
}

/** The issue tracker every usable proposal names, when they all name the same. */
function sharedIssueTracker(
	proposals: RepoProposal[],
): Record<string, unknown> | undefined {
	const trackers = proposals
		.filter(({problems}) => problems.length === 0)
		.map(proposal => {
			const tracker: Record<string, unknown> = {};
			for (const value of proposedValues(proposal)) {
				if (value.path[0] === 'issue_tracker' && value.path.length === 2)
					tracker[value.path[1]!] = value.value;
			}

			return tracker;
		});
	const [first] = trackers;
	if (!first || Object.keys(first).length === 0) return undefined;
	const text = (tracker: Record<string, unknown>) =>
		JSON.stringify(tracker, Object.keys(tracker).sort());
	return trackers.every(tracker => text(tracker) === text(first))
		? first
		: undefined;
}

function isScalarKey(key: unknown): unknown {
	return key && typeof key === 'object' && 'value' in key
		? (key as {value: unknown}).value
		: key;
}

/** Replace one repo's `inferred` section, leaving the rest of the file be. */
export function setInferred(
	document: Document,
	repoName: string,
	inferred: unknown,
): void {
	if (!isMap(document.contents)) document.contents = document.createNode({});
	if (!isMap(document.get('repos', true)))
		document.set('repos', document.createNode({}));
	if (!isMap(document.getIn(['repos', repoName], true)))
		document.setIn(['repos', repoName], document.createNode({}));
	document.setIn(
		['repos', repoName, 'inferred'],
		document.createNode(inferred),
	);
}

function documentText(document: Document): string {
	// Sources are sentences: folding them at 80 columns helps nobody.
	return document.toString({lineWidth: 0});
}

function configPathsFor(
	repo: RepoScan,
	workdir: string,
	homeConfigDir: string,
): ConfigPaths {
	return {
		homeConfigDir,
		workdir: () => workdir,
		repoName: () => repo.name,
		projectDir: repo.path,
		fallbackProjectDir: () => repo.path,
	};
}

/**
 * Why a repo's merged config would be refused if the workdir config read
 * `text`, checked by the loader itself against a copy of the file.
 */
function mergedConfigErrors(
	text: string,
	repo: RepoScan,
	homeConfigDir: string,
): string[] {
	const scratch = makeScratch();
	try {
		const file = path.join(scratch, WORKDIR_CONFIG_FILE);
		fs.mkdirSync(path.dirname(file), {recursive: true});
		fs.writeFileSync(file, text);
		loadRawMergedConfig(configPathsFor(repo, scratch, homeConfigDir));
		return [];
	} catch (error) {
		if (error instanceof ConfigValidationError) return error.errors;
		if (error instanceof ConfigNotFoundError)
			return ['the repo would have no config'];
		return [error instanceof Error ? error.message : String(error)];
	} finally {
		fs.rmSync(scratch, {recursive: true, force: true});
	}
}

// ============================================================================
// Showing a proposal
// ============================================================================

/** A config map as its leaves: lists and scalars, by dotted key. */
function leaves(
	value: unknown,
	prefix: string[] = [],
): Array<[string, unknown]> {
	if (!isRecord(value))
		return prefix.length > 0 ? [[prefix.join('.'), value]] : [];
	return Object.entries(value).flatMap(([key, child]) =>
		leaves(child, [...prefix, key]),
	);
}

function show(value: unknown): string {
	if (typeof value !== 'object' || value === null) return JSON.stringify(value);
	if (Array.isArray(value) && value.every(item => typeof item === 'string'))
		return JSON.stringify(value).replaceAll('","', '", "');
	return `\n${stringify(value, {lineWidth: 0})
		.trimEnd()
		.split('\n')
		.map(text => `        ${text}`)
		.join('\n')}`;
}

function hasPath(value: unknown, keys: string[]): boolean {
	let node = value;
	for (const key of keys) {
		if (!isRecord(node) || !Object.hasOwn(node, key)) return false;
		node = node[key];
	}

	return true;
}

type RepoChange = {
	proposal: RepoProposal;
	values: InferredValue[];
	/** Values `--yes` left out for their confidence. */
	left: InferredValue[];
	lines: string[];
	changed: boolean;
};

/**
 * What accepting a proposal changes in the repo's `inferred` section, key
 * by key, and which of the new values a higher layer overrides anyway.
 */
function describeChange(
	proposal: RepoProposal,
	values: InferredValue[],
	left: InferredValue[],
	context: {document: Document; workdir: string; homeConfigDir: string},
): RepoChange {
	const {repo} = proposal;
	const current: unknown = context.document
		.getIn(['repos', repo.name, 'inferred', 'config'], false)
		?.valueOf();
	const currentJs: unknown = isMap(
		context.document.getIn(['repos', repo.name, 'inferred', 'config'], true),
	)
		? (
				context.document.getIn(
					['repos', repo.name, 'inferred', 'config'],
					true,
				) as {toJSON(): unknown}
			).toJSON()
		: current;
	const before = new Map(leaves(currentJs));
	// The layers that beat inferred values: the repo's own section of the
	// workdir config, its committed config and its local one.
	const above = readConfigLayers(
		configPathsFor(repo, context.workdir, context.homeConfigDir),
	).filter(
		file =>
			file.role === 'project' ||
			file.role === 'local' ||
			(file.role === 'workdir' &&
				file.kind === 'read' &&
				file.section === 'repo'),
	);
	const lines: string[] = [];
	let changed = false;
	for (const value of values) {
		const key = keyOf(value);
		const old = before.get(key);
		before.delete(key);
		const same = JSON.stringify(old) === JSON.stringify(value.value);
		if (!same) changed = true;
		const winner = above.findLast(file => hasPath(layerOf(file), value.path));
		lines.push(
			`  ${old === undefined ? '+' : same ? ' ' : '~'} ${key}: ${
				old === undefined || same ? '' : `${show(old)} -> `
			}${show(value.value)}`,
			`      [${value.confidence}] ${value.source}${
				winner ? `\n      (${winner.label} sets this and wins)` : ''
			}`,
		);
	}

	for (const [key, old] of before) {
		changed = true;
		lines.push(`  - ${key}: ${show(old)}`);
	}

	for (const value of left) {
		lines.push(
			`  ? ${keyOf(value)}: ${show(value.value)}`,
			`      [${value.confidence}] ${value.source} (left out by --yes)`,
		);
	}

	return {proposal, values, left, lines, changed};
}

function seconds(ms: number): string {
	const total = Math.round(ms / 1000);
	return total >= 60 ? `${Math.floor(total / 60)}m${total % 60}s` : `${total}s`;
}

function runFacts(run: ClaudeRun | undefined): string {
	if (!run) return '';
	return [
		seconds(run.durationMs),
		run.costUsd === undefined ? undefined : `$${run.costUsd.toFixed(2)}`,
		run.turns === undefined ? undefined : `${run.turns} turns`,
		run.model,
	]
		.filter(Boolean)
		.join(', ');
}

function formatChange(change: RepoChange): string {
	const {proposal} = change;
	const header = [
		`${proposal.repo.name}${change.changed ? '' : ' (no change)'}`,
		...(proposal.ownConfig
			? [`  its own ${proposal.ownConfig} wins over anything inferred here`]
			: []),
	];
	return [
		...header,
		...change.lines,
		...proposal.notes.map(note => `  note: ${note}`),
	].join('\n');
}

// ============================================================================
// The command
// ============================================================================

export type SetupCommandDeps = {
	cwd: string;
	/** For git, gh, claude and acli, and for JIRA_BASE_URL. */
	env: NodeJS.ProcessEnv;
	out: (text: string) => void;
	err: (text: string) => void;
	/** Whether there is someone to ask. */
	interactive: boolean;
	/** Ask a question and return the line typed. */
	ask: (question: string) => Promise<string>;
	/** Open a file in the user's editor and wait; false when it failed. */
	edit: (file: string) => Promise<boolean>;
	/** Where the home config is read from when a merged config is checked. */
	homeConfigDir?: string;
	repoTimeoutMs?: number;
	toolCheckTimeoutMs?: number;
	now?: () => Date;
};

type SetupOptions = {
	/** The repos to learn; all of them when empty. */
	repos: string[];
	claude: boolean;
	yes: boolean;
	dryRun: boolean;
	model?: string;
	concurrency: number;
};

/** Learn one repo with Claude, on top of what the scan says. */
async function learnRepo(
	proposal: RepoProposal,
	scan: ScanResult,
	access: JiraAccess,
	options: {model?: string; timeoutMs: number; env: NodeJS.ProcessEnv},
): Promise<RepoProposal> {
	const docs = workdirDocs(scan.workdir, proposal.repo);
	const run = await runClaude({
		prompt: repoPrompt(proposal.repo, scan, proposal.profile, access, docs),
		tools: [
			'Read',
			'Grep',
			'Glob',
			'ToolSearch',
			...(access.kind === 'acli' ? ['Bash'] : []),
		],
		// Reading inside the repo needs no rule: --add-dir allows it, and
		// nothing else on disk. A rule's path is absolute after two slashes.
		allowedTools: [
			...docs.map(file => `Read(/${file})`),
			...(access.kind === 'tools' ? access.tools : []),
			...(access.kind === 'acli' ? ACLI_COMMANDS : []),
		],
		disallowedTools: access.kind === 'tools' ? access.otherTools : [],
		addDir: proposal.repo.path,
		model: options.model,
		timeoutMs: options.timeoutMs,
		env: options.env,
	});
	if (!run.ok) return {...proposal, run, problems: [`claude: ${run.error}`]};
	const answer = parseRepoAnswer(run.result, proposal.profile);
	if ('errors' in answer) {
		return {
			...proposal,
			run,
			problems: answer.errors.map(error => `claude's answer: ${error}`),
		};
	}

	return {...proposal, run, learned: answer.values, notes: answer.notes};
}

const SUMMARY_PREFIXES = 20;

/**
 * The prefixes the accepted values name, across the repos: where the scan
 * would put a new ticket, which repos take the prefix for their own new
 * tickets, and which others work on it.
 */
function prefixSummary(scan: ScanResult, changes: RepoChange[]): string[] {
	const owners = new Map<string, string[]>();
	const others = new Map<string, string[]>();
	const add = (map: Map<string, string[]>, prefix: string, repo: string) => {
		map.set(prefix, [...(map.get(prefix) ?? []), repo]);
	};

	for (const {proposal, values} of changes) {
		const {name} = proposal.repo;
		const own = values.find(value => keyOf(value) === 'team_prefix')?.value;
		if (typeof own === 'string') add(owners, own, name);
		const projects = values.find(
			value => value.path.at(-1) === 'tracker_projects',
		)?.value;
		for (const project of Array.isArray(projects) ? projects : []) {
			if (typeof project === 'string' && project !== own)
				add(others, project, name);
		}
	}

	const prefixes = [...new Set([...owners.keys(), ...others.keys()])].sort(
		(a, b) =>
			(scan.prefixes[b]?.keys ?? 0) - (scan.prefixes[a]?.keys ?? 0) ||
			a.localeCompare(b),
	);
	if (prefixes.length === 0) return [];
	const more = prefixes.length - SUMMARY_PREFIXES;
	return [
		'',
		"Ticket prefixes these repos name. The default repo is the scan's: where your local branches with the prefix are, else the largest share of its keys.",
		formatTable([
			['PREFIX', 'DEFAULT REPO', 'NEW TICKETS IN', 'ALSO WORKED ON IN'],
			...prefixes
				.slice(0, SUMMARY_PREFIXES)
				.map(prefix => [
					prefix,
					scan.prefixes[prefix]?.defaultRepo ?? '-',
					owners.get(prefix)?.join(', ') ?? '-',
					others.get(prefix)?.join(', ') ?? '-',
				]),
		]),
		...(more > 0 ? [`(+${more} more)`] : []),
	];
}

/** Exit codes: 0 done, 1 failed, 2 usage, 3 some repos were left as they were. */
export async function runSetupCommand(
	argv: string[],
	deps: SetupCommandDeps,
): Promise<number> {
	if (argv.some(arg => arg === '--help' || arg === '-h')) {
		deps.out(SETUP_HELP);
		return 0;
	}

	const usage = (message: string) => {
		deps.err(`${message}\n${SETUP_USAGE}`);
		return 2;
	};

	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				repo: {type: 'string', multiple: true},
				'no-claude': {type: 'boolean'},
				yes: {type: 'boolean'},
				'dry-run': {type: 'boolean'},
				model: {type: 'string'},
				concurrency: {type: 'string'},
				depth: {type: 'string'},
			},
		});
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error));
	}

	const {values: flags, positionals} = parsed;
	if (positionals.length > 1) return usage('setup takes one directory');
	const depth = flags.depth === undefined ? undefined : Number(flags.depth);
	if (depth !== undefined && (!Number.isInteger(depth) || depth < 0))
		return usage('--depth needs a whole number, 0 or more');
	const concurrency =
		flags.concurrency === undefined
			? REPO_CONCURRENCY
			: Number(flags.concurrency);
	if (!Number.isInteger(concurrency) || concurrency < 1)
		return usage('--concurrency needs a whole number, 1 or more');
	if (flags.model !== undefined && !flags.model.trim())
		return usage('--model needs a model name');
	if (flags.repo?.some(name => !name.trim()))
		return usage('--repo needs a repo name');
	const options: SetupOptions = {
		repos: [...new Set(flags.repo)],
		claude: !flags['no-claude'],
		yes: flags.yes ?? false,
		dryRun: flags['dry-run'] ?? false,
		model: flags.model,
		concurrency,
	};

	const directory = resolveWorkdirArgument(positionals[0], deps.cwd, deps.env);
	if (!fs.statSync(directory, {throwIfNoEntry: false})?.isDirectory()) {
		deps.err(`${directory} is not a directory`);
		return 1;
	}

	const workdir = fs.realpathSync(directory);
	const configFile = path.join(workdir, WORKDIR_CONFIG_FILE);
	const existing = fs.existsSync(configFile)
		? fs.readFileSync(configFile, 'utf8')
		: undefined;
	const document = parseWorkdirDocument(existing);
	if (document.errors.length > 0) {
		deps.err(
			`${configFile} can't be read, so setup would have to guess what to keep: ${document.errors[0]!.message}`,
		);
		return 1;
	}

	// Checked before any Claude is paid for.
	if (
		options.claude &&
		Bun.which('claude', {PATH: deps.env['PATH'] ?? ''}) === null
	) {
		deps.err(
			'claude was not found on PATH. Install Claude Code, or pass --no-claude to write defaults from the scan alone.',
		);
		return 1;
	}

	const scan = await scanWorkdir(workdir, {
		depth,
		env: deps.env,
		now: deps.now?.(),
	});
	const unknown = options.repos.filter(
		name => !scan.repos.some(repo => repo.name === name),
	);
	if (scan.repos.length === 0 || unknown.length > 0) {
		deps.err(
			scan.repos.length === 0
				? `No repos found in ${workdir}`
				: `No repo named ${unknown.join(' or ')} in ${workdir}. Repos: ${scan.repos.map(repo => repo.name).join(', ')}`,
		);
		return 1;
	}

	if (!options.dryRun) writeScan(scan);
	deps.out(
		`Scanned ${workdir}: ${plural(scan.repos.length, 'repo')}, ${plural(Object.keys(scan.prefixes).length, 'ticket prefix', 'ticket prefixes')}${
			options.dryRun ? '' : ` (${WORKDIR_SCAN_FILE} written)`
		}`,
	);

	const clashes = new Map(
		scan.nameClashes.map(({name, paths}) => [name, paths.length]),
	);
	let proposals = scan.repos
		.filter(
			repo => options.repos.length === 0 || options.repos.includes(repo.name),
		)
		.map((repo): RepoProposal => {
			const own = readOwnConfig(repo);
			const profile = profileFor(repo, own);
			return {
				repo,
				profile,
				...(own ? {ownConfig: own.file} : {}),
				defaults: scanDefaults(repo, profile, own, deps.env),
				learned: [],
				notes: [],
				problems: clashes.has(repo.name)
					? [
							`${clashes.get(repo.name)} checkouts are named ${repo.name}, and config is kept by name`,
						]
					: [],
			};
		});

	if (options.claude) {
		const check = await checkJiraAccess({
			env: deps.env,
			model: options.model,
			timeoutMs: deps.toolCheckTimeoutMs ?? TOOL_CHECK_TIMEOUT_MS,
		});
		const checked = check.runs.at(-1)!;
		if (!checked.ok) {
			deps.err(
				`claude could not be run: ${checked.error}\nPass --no-claude to write defaults from the scan alone.`,
			);
			return 1;
		}

		deps.out(
			`Sources: the scan, each repo's docs, and ${describeJiraAccess(check.access)}. Tool check: ${check.runs.map(run => runFacts(run)).join('; ')}`,
		);
		const learning = proposals.filter(({problems}) => problems.length === 0);
		deps.out(
			`Learning ${learning.length === 1 ? learning[0]!.repo.name : `${learning.length} repos, ${Math.min(options.concurrency, learning.length)} at a time`}...`,
		);
		const started = Date.now();
		const learned = await pLimit(
			proposals.map(proposal => async () => {
				if (proposal.problems.length > 0) return proposal;
				const result = await learnRepo(proposal, scan, check.access, {
					model: options.model,
					timeoutMs: deps.repoTimeoutMs ?? REPO_TIMEOUT_MS,
					env: deps.env,
				});
				deps.out(
					`  ${result.repo.name}: ${
						result.problems.length > 0
							? result.problems[0]!
							: plural(result.learned.length, 'value')
					} (${runFacts(result.run)})`,
				);
				return result;
			}),
			options.concurrency,
		);
		proposals = learned.map((result, index) => result ?? proposals[index]!);
		const cost = [...check.runs, ...proposals.map(({run}) => run)].reduce(
			(sum, run) => sum + (run?.costUsd ?? 0),
			0,
		);
		deps.out(
			`Learned in ${seconds(Date.now() - started)}${cost > 0 ? `. Claude cost: $${cost.toFixed(2)}` : ''}`,
		);
	}

	// Each proposal is tried on a copy of the file, and only the ones whose
	// merged config the loader accepts are carried into the candidate.
	const homeConfigDir = deps.homeConfigDir ?? getDefaultHomeConfigDir();
	const candidate = document.clone();
	const changes: RepoChange[] = [];
	for (const proposal of proposals) {
		if (proposal.problems.length > 0) continue;
		const picked = options.yes
			? highConfidenceValues(proposal)
			: {kept: proposedValues(proposal), left: []};
		const {left} = picked;
		const errorsWith = (values: InferredValue[]) => {
			const attempt = candidate.clone();
			setInferred(attempt, proposal.repo.name, inferredSection(values));
			return mergedConfigErrors(
				documentText(attempt),
				proposal.repo,
				homeConfigDir,
			);
		};

		let {kept} = picked;
		let errors = errorsWith(kept);
		// When the repo's own config is fine without them, leave out the
		// inferred values that clash with it (a repo still on
		// post_worktree_init, say) and keep the rest.
		if (errors.length > 0 && errorsWith([]).length === 0) {
			for (const value of kept) {
				const without = kept.filter(other => other !== value);
				const remaining = errorsWith(without);
				if (remaining.length < errors.length) {
					proposal.notes.push(
						`left out ${keyOf(value)}: with the repo's own config it gives ${errors[0]}`,
					);
					kept = without;
					errors = remaining;
					if (errors.length === 0) break;
				}
			}
		}

		if (errors.length > 0) {
			proposal.problems.push(
				...errors.map(error => `the merged config would be invalid: ${error}`),
			);
			continue;
		}

		changes.push(
			describeChange(proposal, kept, left, {document, workdir, homeConfigDir}),
		);
		setInferred(candidate, proposal.repo.name, inferredSection(kept));
	}

	const reported = proposals.filter(({problems}) => problems.length > 0);
	const finish = (outcome: string) => {
		if (reported.length > 0) {
			deps.out(
				[
					'',
					'Left as they were:',
					...reported.flatMap(({repo, problems}) =>
						problems.map(problem => `  ${repo.name}: ${problem}`),
					),
				].join('\n'),
			);
		}

		deps.out(`\n${outcome}`);
		return reported.length > 0 ? 3 : 0;
	};

	const sharedTracker = sharedIssueTracker(proposals);
	const write = (written: Document) => {
		scaffoldTopLevel(written, workdir, sharedTracker);
		fs.mkdirSync(path.dirname(configFile), {recursive: true});
		fs.writeFileSync(configFile, documentText(written));
		return finish(`Wrote ${configFile}`);
	};

	deps.out(`\nProposed for ${configFile}:`);
	const topLevel = scaffoldTopLevel(candidate.clone(), workdir, sharedTracker);
	if (topLevel.length > 0) {
		deps.out(
			`\ntop level, for the work dir's own spaces (its root and ticket spaces); yours to edit, never rewritten:\n${topLevel.map(line => `  + ${line}`).join('\n')}`,
		);
	}

	for (const change of changes) deps.out(`\n${formatChange(change)}`);
	const summary = prefixSummary(scan, changes);
	if (summary.length > 0) deps.out(summary.join('\n'));
	const pending = changes.filter(({changed}) => changed);

	if (options.dryRun) return finish('Dry run: nothing written');
	if (pending.length === 0) return finish('Nothing to change');
	if (options.yes) return write(candidate);
	if (!deps.interactive) {
		return finish(
			'Not a terminal, so nothing was written. Run it from a terminal to choose, or with --yes to accept the high-confidence values.',
		);
	}

	const answerTo = async (question: string) => {
		const answer = await deps.ask(question);
		return answer.trim().toLowerCase();
	};

	for (;;) {
		// eslint-disable-next-line no-await-in-loop -- One question at a time.
		const answer = await answerTo(
			`\nWrite ${pending.length === 1 ? 'this' : `these ${pending.length} repos`}? [a]ccept all, go [r]epo by repo, [e]dit the file first, [q]uit: `,
		);
		if (answer === 'q' || answer === '') return finish('Nothing written');
		if (answer === 'a') return write(candidate);
		if (answer === 'r') {
			const accepted = document.clone();
			let any = false;
			for (const change of pending) {
				const {name} = change.proposal.repo;
				// eslint-disable-next-line no-await-in-loop -- One question at a time.
				const reply = await answerTo(`  ${name}? [y]es, [n]o, [q]uit: `);
				if (reply === 'q') return finish('Nothing written');
				if (reply === 'y') {
					setInferred(accepted, name, inferredSection(change.values));
					any = true;
				}
			}

			return any ? write(accepted) : finish('Nothing written');
		}

		if (answer === 'e') {
			const scratch = makeScratch();
			const draft = path.join(scratch, 'workdir.yml');
			fs.writeFileSync(draft, documentText(candidate));
			try {
				// eslint-disable-next-line no-await-in-loop -- The editor is the question.
				if (!(await deps.edit(draft))) {
					deps.err('The editor failed, so the proposal is unchanged');
					continue;
				}

				const edited = fs.readFileSync(draft, 'utf8');
				const errors = [
					...parseDocument(edited).errors.map(error => error.message),
					...changes.flatMap(({proposal}) =>
						mergedConfigErrors(edited, proposal.repo, homeConfigDir).map(
							error => `${proposal.repo.name}: ${error}`,
						),
					),
				];
				if (errors.length > 0) {
					deps.err(
						`The edited file is not valid, so it was not written:\n${[...new Set(errors)].map(error => `  ${error}`).join('\n')}`,
					);
					continue;
				}

				return write(parseDocument(edited));
			} finally {
				fs.rmSync(scratch, {recursive: true, force: true});
			}
		}
	}
}

export function defaultSetupCommandDeps(): SetupCommandDeps {
	return {
		cwd: process.cwd(),
		env: process.env,
		out(text) {
			console.log(text);
		},
		err(text) {
			console.error(text);
		},
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		async ask(question) {
			const readline = createInterface({
				input: process.stdin,
				output: process.stdout,
			});
			try {
				return await readline.question(question);
			} finally {
				readline.close();
			}
		},
		async edit(file) {
			const editor = process.env['VISUAL'] || process.env['EDITOR'] || 'vi';
			return new Promise(resolve => {
				// Through a shell, since EDITOR is often a command with flags.
				const child = spawn(`${editor} "$1"`, ['sh', file], {
					shell: true,
					stdio: 'inherit',
				});
				child.on('error', () => {
					resolve(false);
				});
				child.on('close', code => {
					resolve(code === 0);
				});
			});
		},
	};
}
