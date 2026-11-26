// Which repos a ticket prefix is worked on in, as `lasagna scan` last
// found: `<workdir>/.lasagna/scan.json`. The new-space dialog reads it to
// suggest a repo for an issue key. It is a suggestion and nothing more, so a
// file that is missing, from another version, or not what scan writes means
// no suggestions, never an error.

import fs from 'node:fs';
import path from 'node:path';

/** Where scan leaves its result, relative to the work dir. */
export const SCAN_FILE = path.join('.lasagna', 'scan.json');

/** The scan.json version this reads. */
const SCAN_VERSION = 1;

export type PrefixRepos = {
	/** The repo a new space for this prefix goes in. */
	defaultRepo?: string;
	/** Each repo's share of the prefix's keys, largest first. */
	repos: Array<{name: string; share: number}>;
};

/** Ticket prefix (`B2B`) to the repos it is worked on in. */
export type ScanSuggestions = ReadonlyMap<string, PrefixRepos>;

const NONE: ScanSuggestions = new Map();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sharesOf(value: unknown): Array<{name: string; share: number}> {
	if (!isRecord(value)) return [];
	return Object.entries(value)
		.flatMap(([name, share]) =>
			typeof share === 'number' && Number.isFinite(share) && share > 0
				? [{name, share}]
				: [],
		)
		.sort((a, b) => b.share - a.share);
}

/** The prefix map of a scan.json's text; empty for anything else. */
export function parseScanSuggestions(content: string): ScanSuggestions {
	let scan: unknown;
	try {
		scan = JSON.parse(content);
	} catch {
		return NONE;
	}

	if (!isRecord(scan) || scan['version'] !== SCAN_VERSION) return NONE;
	const {prefixes} = scan;
	if (!isRecord(prefixes)) return NONE;
	const suggestions = new Map<string, PrefixRepos>();
	for (const [prefix, summary] of Object.entries(prefixes)) {
		if (!isRecord(summary)) continue;
		const repos = sharesOf(summary['repos']);
		const {defaultRepo} = summary;
		const named =
			typeof defaultRepo === 'string' && defaultRepo ? defaultRepo : undefined;
		if (repos.length === 0 && named === undefined) continue;
		suggestions.set(prefix.toUpperCase(), {
			...(named === undefined ? {} : {defaultRepo: named}),
			repos,
		});
	}

	return suggestions;
}

/** What the work dir's last scan says of each prefix; empty without one. */
export function readScanSuggestions(workdir: string): ScanSuggestions {
	try {
		return parseScanSuggestions(
			fs.readFileSync(path.join(workdir, SCAN_FILE), 'utf8'),
		);
	} catch {
		return NONE;
	}
}

/**
 * The prefix of an issue key (`B2B-3184` is `B2B`), or undefined for text
 * that is not one. The same shape scan counts keys by.
 */
export function issuePrefix(input: string): string | undefined {
	return /^([a-z][a-z\d]*)-\d+$/i.exec(input.trim())?.[1]?.toUpperCase();
}
