// Pure helpers for RepoPicker, the list that asks which repo a new space is
// made in on a rail that shows a whole work dir.

import {typedText, type KeyPress} from './key-press.ts';

export type RepoPickerStep =
	| {kind: 'move'; index: number}
	| {kind: 'pick'; index: number}
	| {kind: 'cancel'}
	| {kind: 'ignore'};

/**
 * What a key does to the list: j/k and the arrows move, a digit picks that
 * row outright (1 is the first), Enter picks the highlighted row, Escape
 * and q leave without picking.
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
	if (key.name === 'up' || input === 'k')
		return {kind: 'move', index: Math.max(0, index - 1)};
	if (key.name === 'down' || input === 'j')
		return {kind: 'move', index: Math.min(count - 1, index + 1)};
	if (/^[1-9]$/.test(input) && Number(input) <= count)
		return {kind: 'pick', index: Number(input) - 1};
	return {kind: 'ignore'};
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
