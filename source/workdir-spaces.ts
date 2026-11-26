// `lasagna spaces` at a work dir's root: the open spaces of every repo
// the work dir lists, each named `repo:KEY`, which is the name every other
// command takes for it from there.

import {issueTrackerFor, recordIssueTitles} from './providers/index.ts';
import {formatSpaceRef} from './space-ref.ts';
import {
	formatSpaces,
	gatherSpaces,
	NO_SPACES_FILE,
	worktreeGitSummary,
	type SpacesDeps,
	type SpacesReport,
} from './spaces-command.ts';
import type {StateDaos} from './state-daos.ts';
import {startWorkdir} from './workdir-runtime.ts';

/**
 * One board for several repos. A repo that never had a space adds nothing; a
 * repo whose registry can't be read fails the whole board, named, because an
 * agent reads this as the list of spaces and must not be told one repo has
 * none.
 */
export async function gatherWorkdirSpaces(
	repos: SpacesDeps[],
	now = Date.now(),
): Promise<SpacesReport> {
	const reports = await Promise.all(
		repos.map(async deps => ({
			repo: deps.repoName,
			report: await gatherSpaces({...deps, now}),
		})),
	);
	const unreadable = reports.flatMap(({repo, report}) =>
		'error' in report && report.error !== NO_SPACES_FILE
			? [`${repo}: ${report.error}`]
			: [],
	);
	if (unreadable.length > 0) return {error: unreadable.join('\n'), spaces: []};
	const spaces = reports.flatMap(({repo, report}) =>
		report.spaces.map(space => ({
			...space,
			name: formatSpaceRef(repo, space.name),
		})),
	);
	return {totalSpaces: spaces.length, spaces, timestamp: now};
}

export async function runWorkdirSpacesCommand(options: {
	/** The work dir's root. */
	root: string;
	/** The work dir's own pseudo-repo, already set up. */
	own: {repoName: string; daos: StateDaos};
	home: string;
	json: boolean;
	out: (text: string) => void;
}): Promise<number> {
	const workdir = startWorkdir(options.root, options.own);
	const report = await gatherWorkdirSpaces(
		workdir.repos.map(repo => ({
			repoName: repo.name,
			registry: repo.daos.registry,
			spaceIdentities: repo.daos.spaceIdentities,
			claudeStatus: repo.daos.claudeStatus,
			spaceState: repo.daos.spaceState,
			issueMeta: repo.daos.issueMeta,
			home: options.home,
			async fetchTitles(keys) {
				const issues = await issueTrackerFor(repo.name).getIssues(keys);
				await recordIssueTitles(issues, repo.name);
				return new Map(
					[...issues].map(([key, issue]) => [key, issue?.title ?? null]),
				);
			},
			gitSummary: worktreeGitSummary,
		})),
	);
	options.out(
		options.json ? JSON.stringify(report, null, 2) : formatSpaces(report),
	);
	return 0;
}
