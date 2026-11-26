// The supervise verbs at a work dir's root. One that names a space is pointed
// at that space's repo before it runs (cli-repo-target.ts). The ones that
// name none, or several, are about every repo of the work dir: they run on
// the work dir's stores, where a space is called `repo:KEY`.

import {cliSpaceKey} from './cli-space-key.ts';
import {readBeadsIssuePrefix} from './config.ts';
import {formatConfigErrors} from './config-errors.ts';
import {issueTrackerFor} from './providers/index.ts';
import {formatSpaceRef, parseSpaceRef} from './space-ref.ts';
import type {StateDaos} from './state-daos.ts';
import type {SuperviseDeps} from './supervise-command.ts';
import {defaultSuperviseDeps} from './supervise-runtime.ts';
import {
	startWorkdir,
	type WorkdirRepo,
	type WorkdirRepoSetup,
	type WorkdirRuntime,
} from './workdir-runtime.ts';

/**
 * Whether a supervise invocation run for a work dir is about every repo's
 * spaces: `watch` (any agent, or the ones named across repos), and the lists
 * `holds` and `schedules`. Resolving a hold or cancelling a wake-up names an
 * id, which is found in its repo beforehand.
 */
export function spansWorkdir(argv: readonly string[]): boolean {
	const [verb, second] = argv;
	return (
		verb === 'watch' ||
		verb === 'schedules' ||
		(verb === 'holds' && second !== 'approve' && second !== 'dismiss')
	);
}

/**
 * A space as typed, by the name it has on a work dir's stores. `repo:KEY`
 * for a repo of the work dir is that repo's space, its key read the way that
 * repo reads keys (`resolveIn`); anything else is one of the work dir's own.
 */
export function workdirSpaceName(
	raw: string,
	workdir: Pick<WorkdirRuntime, 'own' | 'repo'>,
	resolveIn: (repo: WorkdirRepo, key: string) => string,
): string {
	const ref = parseSpaceRef(raw);
	const named = ref.repo === undefined ? undefined : workdir.repo(ref.repo);
	const repo = named ?? workdir.own;
	return formatSpaceRef(repo.name, resolveIn(repo, named ? ref.key : raw));
}

/** A key as its repo reads it: a bare number takes that repo's team prefix. */
function keyIn(repo: WorkdirRepo, key: string): string {
	const resolved = cliSpaceKey(
		key,
		repo.context.readConfig(),
		issueTrackerFor(repo.name).name,
		() => readBeadsIssuePrefix(repo.context.mainRoot),
	);
	if (resolved.kind === 'key') return resolved.key;
	throw new Error(
		`${key} needs team_prefix from the config of ${repo.name}, which is invalid:\n${formatConfigErrors(resolved.errors)}`,
	);
}

/**
 * What the supervise verbs run on for the work dir at `root`: every repo it
 * lists set up beside its own pseudo-repo (`own`, already set up), behind
 * one set of stores. From here on this process names a space `repo:KEY`.
 */
export function workdirSuperviseDeps(
	root: string,
	own: {repoName: string; daos: StateDaos},
	options: {setup?: WorkdirRepoSetup} = {},
): SuperviseDeps {
	const workdir = startWorkdir(root, own, options);
	return defaultSuperviseDeps(
		raw => workdirSpaceName(raw, workdir, keyIn),
		workdir.daos,
	);
}
