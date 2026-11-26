// What setup may infer for a repo, and reading a headless Claude's answer
// into it. One list of keys tells Claude what it may answer and decides what
// is accepted from it, so the two can't drift.

export type Confidence = 'high' | 'medium' | 'low';
export const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low'];

/** One inferred setting: a config key, its value and why. */
export type InferredValue = {
	/** The key's path in the config. */
	path: string[];
	value: unknown;
	source: string;
	confidence: Confidence;
};

export type KeySpec = {
	/** The config key, with `<profile>` for the repo's profile. */
	key: string;
	type: string;
	meaning: string;
	/** What is wrong with a value, if anything. */
	problem: (value: unknown) => string | undefined;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function line(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.trim())
		return 'must be a non-empty string';
	return /[\r\n]/.test(value) ? 'must be a single line' : undefined;
}

function oneOf(...allowed: string[]) {
	return (value: unknown) =>
		typeof value === 'string' && allowed.includes(value)
			? undefined
			: `must be one of ${allowed.join(', ')}`;
}

function lines(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length === 0)
		return 'must be a non-empty list of strings';
	return value.every(item => line(item) === undefined)
		? undefined
		: 'must list non-empty single-line strings';
}

const PROJECT_KEY = /^[A-Z][A-Z\d]+$/;

function projectKeys(value: unknown): string | undefined {
	return (
		lines(value) ??
		((value as string[]).every(item => PROJECT_KEY.test(item))
			? undefined
			: 'must list upper-case project keys like B2B')
	);
}

function url(value: unknown): string | undefined {
	if (typeof value !== 'string') return 'must be a URL';
	try {
		return ['http:', 'https:'].includes(new URL(value).protocol)
			? undefined
			: 'must be an http(s) URL';
	} catch {
		return 'must be a URL';
	}
}

const COMMAND_FIELDS = new Set(['name', 'run', 'continue_on_error']);

function commands(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length === 0)
		return 'must be a non-empty list of commands';
	for (const [index, command] of value.entries()) {
		if (!isRecord(command)) return `[${index}] must be a map`;
		const unknown = Object.keys(command).find(
			field => !COMMAND_FIELDS.has(field),
		);
		if (unknown) return `[${index}].${unknown} is not a command field`;
		const name = line(command['name']);
		if (name !== undefined) return `[${index}].name ${name}`;
		if (typeof command['run'] !== 'string' || !command['run'].trim())
			return `[${index}].run must be a non-empty string`;
		if (
			command['continue_on_error'] !== undefined &&
			typeof command['continue_on_error'] !== 'boolean'
		)
			return `[${index}].continue_on_error must be true or false`;
	}

	return undefined;
}

/**
 * The config keys setup may infer. The vars are limited to two names because
 * idow turns every var into a shell variable of its own.
 */
export const KEY_SPECS: readonly KeySpec[] = [
	{
		key: 'team_prefix',
		type: 'string',
		meaning:
			'The Jira project key that new tickets for this repo are created in, and that a bare number like 123 resolves to. Upper case, e.g. "B2B".',
		problem: value =>
			typeof value === 'string' && PROJECT_KEY.test(value)
				? undefined
				: 'must be an upper-case project key like B2B',
	},
	{
		key: 'issue_tracker.provider',
		type: '"jira" | "linear" | "beads"',
		meaning:
			'The issue tracker the keys belong to. Set it only on evidence: a Jira lookup that worked, or docs that name the tracker.',
		problem: oneOf('jira', 'linear', 'beads'),
	},
	{
		key: 'issue_tracker.base_url',
		type: 'string',
		meaning:
			'The Jira site, e.g. "https://acme.atlassian.net". Needed when the provider is jira.',
		problem: url,
	},
	{
		key: 'issue_tracker.default_issue_type',
		type: 'string',
		meaning:
			'The issue type new tickets get, e.g. "Task" or "Story", as the docs say or as the team_prefix project\'s recent issues use.',
		problem: line,
	},
	{
		key: 'vcs_host.provider',
		type: '"github" | "gitlab"',
		meaning: 'Where the repo is hosted. Leave out for GitHub, the default.',
		problem: oneOf('github', 'gitlab'),
	},
	{
		key: 'post_workspace_init',
		type: '[{name: string, run: string, continue_on_error?: boolean}]',
		meaning:
			'Shell commands that make a fresh git worktree of this repo ready to work in, in order.',
		problem: commands,
	},
	{
		key: 'profiles.<profile>.display_name',
		type: 'string',
		meaning: 'A short human name for the repo, e.g. "Appian server (Kotlin)".',
		problem: line,
	},
	{
		key: 'profiles.<profile>.keywords',
		type: 'string[]',
		meaning:
			'Lower-case words that, in a one-line task description, mean the task belongs to this repo.',
		problem: lines,
	},
	{
		key: 'profiles.<profile>.tracker_projects',
		type: 'string[]',
		meaning:
			'Every Jira project key whose tickets are worked on in this repo, the team_prefix first.',
		problem: projectKeys,
	},
	{
		key: 'profiles.<profile>.vcs.label',
		type: 'string',
		meaning: "The label this repo's PRs get, if the docs name one.",
		problem: line,
	},
	{
		key: 'profiles.<profile>.vars.PR_TEMPLATE',
		type: 'string',
		meaning:
			'The PR template, as a path from the repo root, e.g. ".github/pull_request_template.md".',
		problem: line,
	},
	{
		key: 'profiles.<profile>.vars.PR_TITLE_FORMAT',
		type: 'string',
		meaning:
			'The PR title convention as a pattern, e.g. "[KEY] Summary" or "KEY: summary".',
		problem: line,
	},
];

export function keyFor(spec: KeySpec, profile: string): string {
	return spec.key.replace('<profile>', profile);
}

function pathFor(spec: KeySpec, profile: string): string[] {
	return spec.key
		.split('.')
		.map(part => (part === '<profile>' ? profile : part));
}

export function keyOf(value: InferredValue): string {
	return value.path.join('.');
}

/** Later values replace earlier ones with the same key. */
export function mergeValues(...lists: InferredValue[][]): InferredValue[] {
	const merged = new Map<string, InferredValue>();
	for (const value of lists.flat()) merged.set(keyOf(value), value);
	return [...merged.values()];
}

/**
 * The JSON object in Claude's reply. It is asked for the object alone, but a
 * sentence before it or a code fence around it is common, so the object is
 * taken from inside either.
 */
function answerObject(text: string): unknown {
	const trimmed = text.trim();
	const candidates = [trimmed];
	const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
	if (fenced) candidates.push(fenced[1]!);
	const open = trimmed.indexOf('{');
	const close = trimmed.lastIndexOf('}');
	if (open !== -1 && close > open)
		candidates.push(trimmed.slice(open, close + 1));
	let failure: unknown;
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch (error) {
			failure ??= error;
		}
	}

	throw failure;
}

const ANSWER_FIELDS = new Set(['values', 'notes']);
const VALUE_FIELDS = new Set(['key', 'value', 'source', 'confidence']);

export type RepoAnswer = {values: InferredValue[]; notes: string[]};

/**
 * Read a per-repo answer. Anything outside the answer's shape or the keys
 * setup may infer makes the whole answer invalid, so a half-understood
 * answer is never written.
 */
export function parseRepoAnswer(
	text: string,
	profile: string,
): RepoAnswer | {errors: string[]} {
	let answer: unknown;
	try {
		answer = answerObject(text);
	} catch (error) {
		return {
			errors: [
				`the answer is not JSON: ${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}

	if (!isRecord(answer)) return {errors: ['the answer must be a JSON object']};
	const errors: string[] = [];
	for (const field of Object.keys(answer)) {
		if (!ANSWER_FIELDS.has(field))
			errors.push(`${field} is not part of the answer`);
	}

	const notes = answer['notes'] ?? [];
	if (!Array.isArray(notes) || notes.some(note => line(note) !== undefined))
		errors.push('notes must be a list of single-line strings');
	if (!Array.isArray(answer['values']))
		return {errors: [...errors, 'values must be a list']};

	const specs = new Map(KEY_SPECS.map(spec => [keyFor(spec, profile), spec]));
	const values: InferredValue[] = [];
	// A value with a problem of its own is dropped, with a note saying why,
	// so one bad value doesn't cost the repo every other one. Only an answer
	// whose shape is wrong is refused as a whole.
	const dropped: string[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of answer['values'].entries()) {
		const where = `values[${index}]`;
		if (!isRecord(entry)) {
			errors.push(`${where} must be an object`);
			continue;
		}

		const {key, value, confidence} = entry;
		const spec = typeof key === 'string' ? specs.get(key) : undefined;
		if (typeof key !== 'string' || !spec) {
			dropped.push(`${JSON.stringify(key)} is not a key setup infers`);
			continue;
		}

		if (seen.has(key)) {
			errors.push(`${where}.key ${key} is given twice`);
			continue;
		}

		seen.add(key);
		// A source spread over lines is still a source.
		const source =
			typeof entry['source'] === 'string'
				? entry['source'].replaceAll(/\s+/g, ' ').trim()
				: entry['source'];
		const problems = [
			...Object.keys(entry)
				.filter(field => !VALUE_FIELDS.has(field))
				.map(field => `${field} is not part of a value`),
			spec.problem(value),
			line(source) && `source ${line(source)}`,
			!CONFIDENCES.includes(confidence as Confidence) &&
				`confidence must be one of ${CONFIDENCES.join(', ')}`,
		].filter((problem): problem is string => typeof problem === 'string');
		if (problems.length > 0) {
			dropped.push(`${key}: ${problems.join('; ')}`);
			continue;
		}

		values.push({
			path: pathFor(spec, profile),
			value: key === 'post_workspace_init' ? forgivingSteps(value) : value,
			source: source as string,
			confidence: confidence as Confidence,
		});
	}

	if (errors.length > 0) return {errors};
	return {
		values,
		notes: [
			...(notes as string[]),
			...dropped.map(problem => `left out ${problem}`),
		],
	};
}

/**
 * A setup step Claude worked out must not stop a space from opening: one
 * run wrote a git-crypt unlock that fails in a locked checkout, without
 * continue_on_error. A step keeps the flag it was given; the rest get it.
 *
 * Nor may it end or move idow, which evals every step in its own shell: that
 * unlock ended in `exit $rc`, and the space opened with no first prompt and
 * no error. So each step's run is put in a subshell. It is done here, to the
 * steps setup writes, and not in idow: a step a person wrote runs as it
 * always has.
 */
function forgivingSteps(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map(step => {
		if (!isRecord(step)) return step;
		return {
			...step,
			...(typeof step['run'] === 'string' && {run: inSubshell(step['run'])}),
			...(step['continue_on_error'] === undefined && {
				continue_on_error: true,
			}),
		};
	});
}

/**
 * `run` as a subshell, where an `exit` ends and a `cd` moves only the step,
 * unless it is one already. After a run with a comment or several lines the
 * closing parenthesis gets a line of its own, since a comment would take it.
 */
export function inSubshell(run: string): string {
	const command = run.trim();
	if (isSubshell(command)) return command;
	return /[#\n]/.test(command) ? `(\n${command}\n)` : `( ${command} )`;
}

/**
 * Whether a command is one `( ... )` from its first character to its last.
 * `(a) && (b)` is not, and when in doubt the answer is no: a subshell inside
 * another one does no harm.
 */
function isSubshell(command: string): boolean {
	// A parenthesis that is quoted or escaped groups nothing: blank those out,
	// keeping every other character where it was.
	const bare = command.replaceAll(/\\.|'[^']*'|"(?:\\.|[^"\\])*"/gs, quoted =>
		' '.repeat(quoted.length),
	);
	if (!bare.startsWith('(') || !bare.endsWith(')')) return false;
	let depth = 0;
	for (const [index, char] of [...bare].entries()) {
		if (char === '(') depth++;
		if (char !== ')') continue;
		depth--;
		// Closed before the end: what follows is outside the first group.
		if (depth <= 0 && index < bare.length - 1) return false;
	}

	return depth === 0;
}
