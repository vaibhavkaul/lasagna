// Pure helpers for RepoPicker, the list that asks which repos a new space is
// made in on a rail that shows a whole work dir.

import {typedText, type KeyPress} from './key-press.ts';
import {issuePrefix, type ScanSuggestions} from './scan-suggestions.ts';

export type RepoPickerStep =
	| {kind: 'move'; index: number}
	| {kind: 'toggle'; index: number}
	| {kind: 'pick'; index: number}
	| {kind: 'cancel'}
	| {kind: 'ignore'};

/**
 * What a key does to the list: j/k and the arrows move, Space ticks the
 * highlighted row (a space in more than one repo is a ticket space), a digit
 * picks that row outright (1 is the first), Enter picks the ticked rows, or
 * the highlighted one when none is ticked, Escape and q leave without
 * picking.
 */
export function repoPickerStep(
	key: KeyPress,
	index: number,
	count: number,
): RepoPickerStep {
	const input = typedText(key);
	if (key.name === 'escape' || input === 'q') return {kind: 'cancel'};
	if (count === 0) return {kind: 'ignore'};
	if (key.name === 'return') return {kind: 'pick', index};
	if (key.name === 'space' || input === ' ') return {kind: 'toggle', index};
	if (key.name === 'up' || input === 'k')
		return {kind: 'move', index: Math.max(0, index - 1)};
	if (key.name === 'down' || input === 'j')
		return {kind: 'move', index: Math.min(count - 1, index + 1)};
	if (/^[1-9]$/.test(input) && Number(input) <= count)
		return {kind: 'pick', index: Number(input) - 1};
	return {kind: 'ignore'};
}

/** The rows ticked after Space on `index`. */
export function toggleRepo(
	ticked: ReadonlySet<number>,
	index: number,
): Set<number> {
	const next = new Set(ticked);
	if (!next.delete(index)) next.add(index);
	return next;
}

/**
 * The repos Enter picks: the ticked rows in the order the list shows them,
 * or the row picked outright when none is ticked.
 */
export function pickedRepos(
	names: readonly string[],
	ticked: ReadonlySet<number>,
	index: number,
): string[] {
	const chosen = names.filter((_, row) => ticked.has(row));
	if (chosen.length > 0) return chosen;
	const name = names[index];
	return name === undefined ? [] : [name];
}

/**
 * The repo the list opens on: the selected space's when it has one, else the
 * repo the last space was made in, else the first.
 */
export function defaultRepoIndex(
	repos: readonly string[],
	selected: string | undefined,
	lastUsed: string | undefined,
): number {
	for (const preferred of [selected, lastUsed]) {
		const index = preferred === undefined ? -1 : repos.indexOf(preferred);
		if (index !== -1) return index;
	}

	return 0;
}

/** One row of the list. */
export type RepoChoice = {
	name: string;
	/** The repo's share of the typed key's prefix, when the scan found one. */
	share?: number;
	/** Whether the typed key's prefix is worked on in this repo. */
	suggested: boolean;
};

export type RepoChoices = {
	/** The prefix of the issue key typed, when the input is one. */
	prefix?: string;
	rows: RepoChoice[];
	/** The row the list opens on: the repo the space goes in unless another is picked. */
	defaultIndex: number;
};

/**
 * The repos to offer for what is typed. An issue key leads with the repos its
 * prefix is worked on in, largest share first, and opens on the prefix's
 * default repo; the other repos follow in the work dir's order. Without a
 * scan, a repo whose own config names the prefix is suggested instead. Free
 * text, and a key whose prefix nothing knows, keeps the work dir's order and
 * opens on the selected space's repo, else the last one used.
 */
export function repoChoices(options: {
	/** The work dir's repos, in its order. */
	repos: readonly string[];
	input: string;
	suggestions: ScanSuggestions;
	/** The repos whose own config names a prefix, for a work dir never scanned. */
	declared?: (prefix: string) => readonly string[];
	selected?: string;
	lastUsed?: string;
}): RepoChoices {
	const {repos, suggestions} = options;
	const prefix = issuePrefix(options.input);
	const found = prefix === undefined ? undefined : suggestions.get(prefix);
	// A repo scan knew that the work dir no longer lists is not offered.
	const scanned = (found?.repos ?? []).filter(({name}) => repos.includes(name));
	const leading: RepoChoice[] =
		scanned.length > 0
			? scanned.map(({name, share}) => ({name, share, suggested: true}))
			: (prefix === undefined ? [] : (options.declared?.(prefix) ?? []))
					.filter(name => repos.includes(name))
					.map(name => ({name, suggested: true}));
	const rows = [
		...leading,
		...repos
			.filter(name => !leading.some(row => row.name === name))
			.map(name => ({name, suggested: false})),
	];
	const names = rows.map(row => row.name);
	const scanDefault =
		found?.defaultRepo !== undefined && names.includes(found.defaultRepo)
			? found.defaultRepo
			: undefined;
	const fallback = defaultRepoIndex(names, options.selected, options.lastUsed);
	const defaultIndex =
		scanDefault === undefined
			? // The repo last worked in wins among the suggested ones; else the
				// largest share leads.
				leading.length > 0 && !rows[fallback]?.suggested
				? 0
				: fallback
			: names.indexOf(scanDefault);
	return {
		...(prefix === undefined ? {} : {prefix}),
		rows,
		defaultIndex,
	};
}

/** A share as the list shows it: `62%`, and `<1%` for a trace. */
export function formatShare(share: number): string {
	const percent = Math.round(share * 100);
	return percent < 1 ? '<1%' : `${percent}%`;
}

/** The rows that fit, keeping the highlighted one in view. */
export function repoPickerWindow(
	count: number,
	index: number,
	rows: number,
): {start: number; end: number} {
	const visible = Math.max(1, Math.min(count, rows));
	const start = Math.max(
		0,
		Math.min(index - Math.floor(visible / 2), count - visible),
	);
	return {start, end: start + visible};
}
