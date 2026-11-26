// Whether a start of the TUI is for a whole work dir. `--workdir <dir>` says
// so outright. Otherwise it is when the TUI is started inside a work dir but
// in none of its configured repos: at its root, in a plain directory below
// it, or in a checkout the work dir does not list. Started in a configured
// repo the TUI is that repo's, as it always was.
//
// A work dir's root can be a git checkout of its own, or sit inside one. That
// checkout is not one of the work dir's repos, so there the TUI is the work
// dir's too, which is how a CLI command run there reads it
// (cli-repo-target.ts).

import fs from 'node:fs';
import path from 'node:path';
import type {RepoRoots} from './config.ts';
import {
	PROJECT_CONFIG_NAME,
	WORKDIR_CONFIG_FILE,
	findWorkdir,
	workdirListsRepo,
	workdirStoodIn,
} from './repo-config-files.ts';

/** Flags whose next argument is their value, not a verb or a prompt. */
const VALUE_FLAGS = new Set([
	'--profile',
	'--agent-profile',
	'--workspace',
	'--workdir',
	'--turns',
	'--keys',
]);

const WORKDIR_FLAG = '--workdir';

/** The value of `--workdir`, in either spelling, and where it is in argv. */
export function workdirFlag(
	argv: readonly string[],
): {index: number; value: string; joined: boolean} | undefined {
	for (const [index, arg] of argv.entries()) {
		if (arg === WORKDIR_FLAG && argv[index + 1] !== undefined)
			return {index: index + 1, value: argv[index + 1]!, joined: false};
		if (arg.startsWith(`${WORKDIR_FLAG}=`))
			return {
				index,
				value: arg.slice(WORKDIR_FLAG.length + 1),
				joined: true,
			};
	}

	return undefined;
}

/** Whether argv starts the TUI: it names no verb and no prompt. */
export function startsTui(argv: readonly string[]): boolean {
	return argv.every(
		(arg, index) =>
			arg.startsWith('-') || VALUE_FLAGS.has(argv[index - 1] ?? ''),
	);
}

export type WorkdirMode =
	/** The process is about the checkout it runs in. */
	| {kind: 'repo'}
	/** The process is about the work dir at `root`; `argv` names it in full. */
	| {kind: 'workdir'; root: string; argv: string[]}
	| {kind: 'error'; message: string};

export function workdirMode(
	argv: readonly string[],
	deps: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		/** The checkout holding a directory, or undefined outside one. */
		checkoutAt: (directory: string) => RepoRoots | undefined;
	},
): WorkdirMode {
	const flag = workdirFlag(argv);
	if (flag) {
		const root = path.resolve(deps.cwd, flag.value);
		if (!fs.existsSync(path.join(root, WORKDIR_CONFIG_FILE)))
			return {
				kind: 'error',
				message: `${root} is not a work dir: it has no ${WORKDIR_CONFIG_FILE}`,
			};
		// The TUI starts again inside tmux, from another directory.
		const absolute = [...argv];
		absolute[flag.index] = flag.joined ? `${WORKDIR_FLAG}=${root}` : root;
		return {kind: 'workdir', root, argv: absolute};
	}

	if (!startsTui(argv)) return {kind: 'repo'};
	const checkout = deps.checkoutAt(deps.cwd);
	// From the directory itself first: its checkout may hold the work dir,
	// and then looking up from that checkout would walk right past it.
	const stoodIn = workdirStoodIn(deps.cwd, checkout?.root, deps.env);
	if (stoodIn !== undefined)
		return {kind: 'workdir', root: stoodIn, argv: [...argv]};
	const root = findWorkdir(checkout?.mainRoot ?? deps.cwd, deps.env);
	if (root === undefined) return {kind: 'repo'};
	const configured =
		checkout !== undefined &&
		(fs.existsSync(path.join(checkout.mainRoot, PROJECT_CONFIG_NAME)) ||
			workdirListsRepo(root, checkout.name));
	return configured ? {kind: 'repo'} : {kind: 'workdir', root, argv: [...argv]};
}
