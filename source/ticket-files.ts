// The files Lasagna writes into a ticket folder for its lead agent, beside
// the repos' worktrees: a CLAUDE.md that says what the folder is and lists
// its repos, and a `.claude/settings.json` with the repos' permissions.
// Claude Code loads only the settings of the folder it starts in, and skips
// an `@` import from outside it, so both are written out in full here. They
// are rewritten whenever a repo is added and removed when the space closes.

import fs from 'node:fs';
import path from 'node:path';
import type {ConfigLoad} from './config.ts';

/** What the lead agent is told about one repo of the ticket. */
export type TicketRepoFacts = {
	name: string;
	/** The repo's worktree for the ticket. */
	worktreePath: string;
	/** The repo's main checkout, which the worktree belongs to. */
	mainRoot: string;
	/** The branch the worktree is on. */
	branch: string;
	/** The branch its pull request goes to. */
	defaultBranch?: string;
	/** The PR template, as a path from the repo's root. */
	prTemplate?: string;
	/** The PR title convention, as the repo's config gives it. */
	prTitleFormat?: string;
	/** The label the repo's PRs get. */
	prLabel?: string;
	/** Whether the repo has rules of its own to read. */
	hasClaudeMd: boolean;
};

export const TICKET_CLAUDE_MD = 'CLAUDE.md';
export const TICKET_SETTINGS = path.join('.claude', 'settings.json');
/** What a plain space's agent left for the lead agent that takes over. */
export const TICKET_HANDOFF = 'HANDOFF.md';

/** Everything Lasagna writes into a ticket folder itself. */
export const TICKET_GENERATED_FILES = [
	TICKET_CLAUDE_MD,
	TICKET_SETTINGS,
	TICKET_HANDOFF,
];

/** Where a PR or MR template is kept, by the name it has there. */
const PR_TEMPLATE_PLACES: Array<[directory: string, name: string]> = [
	['.github', 'pull_request_template.md'],
	['', 'pull_request_template.md'],
	['docs', 'pull_request_template.md'],
	[path.join('.gitlab', 'merge_request_templates'), 'default.md'],
];

/** The template a checkout has, spelled as it is on disk, whatever its case. */
function findPrTemplate(checkout: string): string | undefined {
	for (const [directory, wanted] of PR_TEMPLATE_PLACES) {
		let names: string[];
		try {
			names = fs.readdirSync(path.join(checkout, directory));
		} catch {
			continue;
		}

		const name = names.find(each => each.toLowerCase() === wanted);
		if (name) return path.join(directory, name);
	}

	return undefined;
}

/** The PR rules a repo's config gives, and the template it has on disk. */
export function repoPrRules(
	load: ConfigLoad,
	checkout: string,
): Pick<TicketRepoFacts, 'prTemplate' | 'prTitleFormat' | 'prLabel'> {
	const config = load.kind === 'valid' ? load.config : undefined;
	const name =
		config?.default_profile ?? Object.keys(config?.profiles ?? {})[0];
	const profile = name === undefined ? undefined : config?.profiles[name];
	const text = (value: unknown) =>
		typeof value === 'string' && value.trim() ? value.trim() : undefined;
	const prTemplate =
		text(profile?.vars?.['PR_TEMPLATE']) ?? findPrTemplate(checkout);
	const prTitleFormat = text(profile?.vars?.['PR_TITLE_FORMAT']);
	const prLabel = text(profile?.vcs?.label) ?? text(profile?.github?.label);
	return {
		...(prTemplate === undefined ? {} : {prTemplate}),
		...(prTitleFormat === undefined ? {} : {prTitleFormat}),
		...(prLabel === undefined ? {} : {prLabel}),
	};
}

/** Where a repo's worktree is, as the lead agent reaches it from the folder. */
function repoDir(folder: string, repo: TicketRepoFacts): string {
	const relative = path.relative(folder, repo.worktreePath);
	return relative.startsWith('..') || path.isAbsolute(relative)
		? repo.worktreePath
		: `${relative}/`;
}

/**
 * A work dir's CLAUDE.md, made safe to repeat inside another folder's:
 * headings moved under the section that holds it, links and `@` imports
 * that are relative to the work dir spelled out in full, since from the
 * ticket folder they would point nowhere, or outside it.
 */
export function inlineRules(text: string, root: string): string {
	let fenced = false;
	return text
		.split('\n')
		.map(line => {
			if (/^\s*(```|~~~)/.test(line)) {
				fenced = !fenced;
				return line;
			}

			if (fenced) return line;
			return (
				line
					.replace(/^(#{1,6})(\s)/, (_, hashes: string, space: string) => {
						return `${'#'.repeat(Math.min(6, hashes.length + 2))}${space}`;
					})
					// [text](./file.md) and [text](dir/file.md), not URLs or anchors.
					.replaceAll(
						/\]\((?!\w+:|#|\/|~)([^)\s]+)\)/g,
						(_, target: string) => `](${path.join(root, target)})`,
					)
					// An import is `@path` at the start of a word.
					.replaceAll(
						/(^|\s)@(\.{1,2}\/[^\s]+)/g,
						(_, before: string, target: string) =>
							`${before}\`${path.join(root, target)}\``,
					)
			);
		})
		.join('\n')
		.trim();
}

/** How much of a work dir's rules is repeated before pointing at the file. */
const MAX_RULES_CHARS = 60_000;

export type TicketClaudeMd = {
	key: string;
	title?: string;
	folder: string;
	/** The work dir the repos are from. */
	workdir: {name: string; root: string};
	repos: TicketRepoFacts[];
	/** The work dir's other repos, which can be added. */
	otherRepos: string[];
	/** The work dir's own CLAUDE.md. */
	rules?: {file: string; text: string};
	/** Set while a plain space's agent hands over to the lead agent. */
	hasHandoff?: boolean;
	/**
	 * The permission modes repos set for themselves that the folder's settings
	 * leave out, because not every repo sets the same.
	 */
	unsharedModes?: ReadonlyArray<{repo: string; mode: string}>;
};

export function renderTicketClaudeMd(ticket: TicketClaudeMd): string {
	const {key, folder, workdir, repos} = ticket;
	const lines = [
		`<!-- Generated by Lasagna for the ticket space ${key}. It is rewritten when a repo is added and removed when the space closes: edits here are lost. -->`,
		'',
		`# ${key}${ticket.title ? `: ${ticket.title}` : ''}`,
		'',
		`This is a **ticket folder**: the one place where ${key} is worked on across ${repos.length === 1 ? 'its repo' : `${repos.length} repos`} of the work dir \`${workdir.name}\`. The folder itself is not a git repository. Each repo below is a real git worktree of that repo, on its own branch.`,
		'',
		'| Directory | Repo | Branch | PRs go to |',
		'| --- | --- | --- | --- |',
		...repos.map(
			repo =>
				`| \`${repoDir(folder, repo)}\` | ${repo.name} | \`${repo.branch}\` | ${repo.defaultBranch ? `\`${repo.defaultBranch}\`` : "the repo's default branch"} |`,
		),
		'',
		'## Working here',
		'',
		'- Search from this folder (Grep and Glob with no path) to see the whole change: it reaches every repo.',
		"- Run git, builds and tests inside a repo's directory. `git` in this folder itself fails, because it is no repository.",
		"- Each repo has its own rules. Read a repo's `CLAUDE.md` before you change that repo, and follow it there. A rule in one repo says nothing about another.",
		`- Each repo keeps its own branch and its own pull request. Never put two repos in one PR. Open a repo's PR from its directory, against the branch in the table, following that repo's PR rules below, then record it with the \`link_pr\` tool (or \`lasagna link-pr <url>\`) from that directory.`,
		`- Mention ${key} in every PR, and link the PRs of the other repos in each PR's description when they have to ship together. Say which one goes first.`,
		ticket.otherRepos.length > 0
			? `- If the ticket needs another repo, add it with the \`space_add_repo\` tool (or \`lasagna space add-repo ${key} <repo>\`): its worktree appears here and this file is rewritten. Repos of the work dir not in this ticket: ${ticket.otherRepos.join(', ')}.`
			: `- Every repo of the work dir is already in this ticket.`,
		...(ticket.hasHandoff
			? [
					`- \`${TICKET_HANDOFF}\` in this folder is what the agent that worked on ${key} before left for you: the issue, its last turns and its diff. Read it first.`,
				]
			: []),
		...((ticket.unsharedModes ?? []).length > 0
			? [
					`- Permission mode: ${ticket
						.unsharedModes!.map(
							({repo, mode}) =>
								`${repo}'s own settings start its agent in \`${mode}\``,
						)
						.join(
							'; ',
						)}. This folder does not: a mode set here would cover every repo in it, and not every repo sets that one. Expect to be asked here for what that mode would have let through.`,
				]
			: []),
		'',
		'## Repos',
	];
	for (const repo of repos) {
		const dir = repoDir(folder, repo);
		lines.push(
			'',
			`### ${repo.name}`,
			'',
			`- Directory: \`${dir}\`, a git worktree of \`${repo.mainRoot}\` on the branch \`${repo.branch}\`.`,
			repo.defaultBranch
				? `- Default branch: \`${repo.defaultBranch}\`. Its PR goes there.`
				: '- Default branch: not known. Check `git remote show origin` before opening its PR.',
			repo.prTemplate
				? `- PR template: \`${path.join(dir, repo.prTemplate)}\`. Fill it in for this repo's PR.`
				: '- PR template: none found.',
			...(repo.prTitleFormat
				? [`- PR title format: \`${repo.prTitleFormat}\`.`]
				: []),
			...(repo.prLabel ? [`- PR label: \`${repo.prLabel}\`.`] : []),
			repo.hasClaudeMd
				? `- Rules: \`${path.join(dir, 'CLAUDE.md')}\`.`
				: '- Rules: this repo has no `CLAUDE.md`.',
		);
	}

	if (ticket.rules) {
		const text = inlineRules(ticket.rules.text, workdir.root);
		const cut = text.length > MAX_RULES_CHARS;
		lines.push(
			'',
			'## Work dir rules',
			'',
			`These are the rules of the work dir itself, copied from \`${ticket.rules.file}\` when this file was written. They apply to every repo here unless a repo's own rules say otherwise. Paths in them are given in full, since this folder is outside the work dir.`,
			'',
			cut ? text.slice(0, MAX_RULES_CHARS) : text,
			...(cut
				? ['', `(Cut here. Read the rest in \`${ticket.rules.file}\`.)`]
				: []),
		);
	}

	return `${lines.join('\n')}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const strings = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];

/** The tools whose rule is a file pattern, read from where the settings are. */
const FILE_TOOLS = new Set([
	'Read',
	'Edit',
	'Write',
	'MultiEdit',
	'NotebookEdit',
	'Glob',
	'Grep',
]);

/**
 * A repo's permission rule as it reads from the ticket folder, one level up.
 * A file pattern anchored at the repo (`/src/**`, `./.env`, `src/**`) gains
 * the repo's directory. One that names a place outright (`//abs`, `~/x`) or
 * matches at any depth (`*.pem`, or one starting with `**`) is kept. Other
 * rules (Bash, WebFetch, MCP tools) say nothing about where they run and are
 * kept too.
 *
 * `dir` is the repo's directory in the folder, or the full path of a
 * worktree that stayed outside it. That one is named outright, as `//path`:
 * a rule under the folder would be about a directory that is not there.
 */
export function rerootRule(rule: string, dir: string): string {
	const match = /^([A-Za-z]+)\((.*)\)$/s.exec(rule);
	if (!match || !FILE_TOOLS.has(match[1]!)) return rule;
	const [, tool, pattern] = match as unknown as [string, string, string];
	if (pattern.startsWith('//') || pattern.startsWith('~')) return rule;
	const outside = path.isAbsolute(dir);
	if (pattern.startsWith('/')) return `${tool}(/${dir}${pattern})`;
	if (pattern.startsWith('./'))
		return `${tool}(${outside ? '/' : './'}${dir}/${pattern.slice(2)})`;
	if (pattern.startsWith('**') || !pattern.includes('/')) return rule;
	return `${tool}(${outside ? '/' : ''}${dir}/${pattern})`;
}

export type RepoSettings = {
	/** The repo's name in the work dir. */
	name: string;
	/**
	 * The repo's directory in the ticket folder, or the full path of a
	 * worktree that is not in it.
	 */
	dir: string;
	/** Where the repo's worktree is, for the directories it adds by path. */
	worktreePath: string;
	/** The repo's parsed settings files, the shared one before the local one. */
	settings: unknown[];
};

/** The Lasagna plugin, as a repo's settings turn it on. */
function lasagnaPlugins(enabled: unknown): Record<string, unknown> {
	return isRecord(enabled)
		? Object.fromEntries(
				Object.entries(enabled).filter(([name]) => name.startsWith('lasagna@')),
			)
		: {};
}

/** The mode a repo's own settings start its agent in: the personal file's, else the shared one's. */
function defaultModeOf(repo: RepoSettings): string | undefined {
	let mode: string | undefined;
	for (const file of repo.settings) {
		const permissions = isRecord(file) ? file['permissions'] : undefined;
		if (isRecord(permissions) && typeof permissions['defaultMode'] === 'string')
			mode = permissions['defaultMode'];
	}

	return mode;
}

/**
 * The one mode every repo starts its agent in, if there is one. A mode set
 * in the folder covers every repo in it, so one that only some repos chose
 * (`bypassPermissions` in a single repo) is no mode for the ticket.
 */
function sharedMode(repos: readonly RepoSettings[]): string | undefined {
	const [first, ...rest] = repos.map(repo => defaultModeOf(repo));
	return rest.every(mode => mode === first) ? first : undefined;
}

/** The modes repos set for themselves that the ticket's settings leave out. */
export function unsharedModes(
	repos: readonly RepoSettings[],
): Array<{repo: string; mode: string}> {
	if (sharedMode(repos) !== undefined) return [];
	return repos.flatMap(repo => {
		const mode = defaultModeOf(repo);
		return mode === undefined ? [] : [{repo: repo.name, mode}];
	});
}

/**
 * The lead agent's settings: every repo's permissions as one. A rule any
 * repo allows is allowed and one any repo denies is denied, which Claude
 * Code checks first, so the merge never allows what a repo forbids. The
 * repos' hooks and env are left out: they are written for a session inside
 * that repo. The Lasagna plugin, whose hooks report the agent's status,
 * stays on where a repo turned it on.
 */
export function mergeRepoSettings(
	repos: readonly RepoSettings[],
): Record<string, unknown> {
	const merged: Record<'allow' | 'deny' | 'ask', string[]> = {
		allow: [],
		deny: [],
		ask: [],
	};
	const directories: string[] = [];
	const plugins: Record<string, unknown> = {};
	const add = (list: string[], value: string) => {
		if (!list.includes(value)) list.push(value);
	};

	for (const repo of repos) {
		for (const file of repo.settings) {
			if (!isRecord(file)) continue;
			const {permissions, enabledPlugins} = file;
			if (isRecord(permissions)) {
				for (const kind of ['allow', 'deny', 'ask'] as const) {
					const rules = strings(permissions[kind]).map(rule =>
						rerootRule(rule, repo.dir),
					);
					for (const rule of rules) add(merged[kind], rule);
				}

				for (const directory of strings(permissions['additionalDirectories']))
					add(directories, path.resolve(repo.worktreePath, directory));
			}

			Object.assign(plugins, lasagnaPlugins(enabledPlugins));
		}
	}

	const mode = sharedMode(repos);
	return {
		permissions: {
			allow: merged.allow,
			deny: merged.deny,
			ask: merged.ask,
			...(directories.length > 0 ? {additionalDirectories: directories} : {}),
			...(mode === undefined ? {} : {defaultMode: mode}),
		},
		...(Object.keys(plugins).length > 0 ? {enabledPlugins: plugins} : {}),
	};
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/** A repo's settings as they are in its worktree: shared, then personal. */
export function readRepoSettings(
	folder: string,
	repo: {name: string; worktreePath: string},
): RepoSettings {
	const relative = path.relative(folder, repo.worktreePath);
	return {
		name: repo.name,
		dir:
			relative.startsWith('..') || path.isAbsolute(relative)
				? repo.worktreePath
				: relative,
		worktreePath: repo.worktreePath,
		settings: ['settings.json', 'settings.local.json'].flatMap(name => {
			const parsed = readJson(path.join(repo.worktreePath, '.claude', name));
			return parsed === undefined ? [] : [parsed];
		}),
	};
}

/** Write the folder's generated files, replacing the ones there. */
export function writeTicketFiles(
	folder: string,
	files: {claudeMd: string; settings: Record<string, unknown>},
): void {
	fs.mkdirSync(path.join(folder, '.claude'), {recursive: true});
	fs.writeFileSync(path.join(folder, TICKET_CLAUDE_MD), files.claudeMd);
	fs.writeFileSync(
		path.join(folder, TICKET_SETTINGS),
		`${JSON.stringify(files.settings, null, 2)}\n`,
	);
}

/**
 * Remove what Lasagna wrote into a ticket folder, and nothing else: the
 * repos' worktrees stay, as a closed plain space's worktree does, and so
 * does anything the agent or the user left beside them.
 */
export function removeTicketFiles(folder: string): void {
	for (const file of TICKET_GENERATED_FILES)
		fs.rmSync(path.join(folder, file), {force: true});
	try {
		// Only when nothing else is in it, such as the user's own local settings.
		fs.rmdirSync(path.join(folder, '.claude'));
	} catch {
		// Not empty, or never made.
	}
}
