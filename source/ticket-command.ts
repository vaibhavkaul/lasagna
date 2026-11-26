// `lasagna space add-repo <space> <repo>`: add a repo of the work dir to
// a space. A ticket space gains the repo's worktree in its ticket folder; a
// plain space, which has one repo, becomes a ticket space. The rail's `a` key
// and the `space_add_repo` MCP tool do the same.

import {repoRootsAt, type RepoRoots} from './config.ts';
import {findWorkdir, isWorkdirRepoName} from './repo-config-files.ts';
import {
	repoContextOf,
	workdirRepoContext,
	type RepoContext,
} from './repo-context.ts';
import {parseSpaceRef} from './space-ref.ts';
import {createStateDaos, type StateDaos} from './state-daos.ts';
import {
	addRepoToSpace,
	checkAddRepo,
	TicketError,
	type AddRepoResult,
	type TicketEnv,
} from './ticket-ops.ts';
import {ticketEnv} from './ticket-runtime.ts';
import {ticketStore} from './ticket-space.ts';
import {readWorkdir} from './workdir.ts';

export const ADD_REPO_USAGE = 'Usage: lasagna space add-repo [space] <repo>';

export const ADD_REPO_HELP = `${ADD_REPO_USAGE}

Add a repo of the work dir to a space.

  [space]  A space key, such as B2B-123. repo:KEY names a plain space by its
           repo, when more than one repo has the key. Without it, the space
           this runs in.
  <repo>   A repo the work dir lists.

A ticket space gains the repo's worktree, in its ticket folder
(~/.lasagna/worktrees/_tickets/<workdir>/<KEY>/<repo>, branch <KEY>) and set up with
that repo's own commands. Its CLAUDE.md and settings are written again and its
lead agent is told.

A plain space becomes a ticket space: a lead agent starts in a new ticket
folder with a handoff from the plain space's agent (the issue, its last turns
and its diff), that agent is told and its sessions end, and then its worktree
is moved into the folder. Run from inside a plain space that ends this way,
the command checks that it can be done, then carries on in the background,
since the session it was run from is one of those that end. What goes wrong
there is in the log (~/.lasagna/logs).

Two changes to one ticket run one after the other: a second add-repo waits
for the first.`;

function checkoutAt(directory: string): RepoRoots | undefined {
	try {
		return repoRootsAt(directory);
	} catch {
		return undefined;
	}
}

/**
 * The work dir a command is run for: the one holding the directory, the one
 * holding the checkout the directory is in, or the one of the space the
 * session belongs to, whose worktree is outside the work dir.
 */
export function commandWorkdir(
	cwd: string,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const injected = env['LASAGNA_MAIN_REPO_ROOT'];
	const checkout = checkoutAt(cwd);
	return (
		findWorkdir(cwd, env) ??
		(checkout && findWorkdir(checkout.mainRoot, env)) ??
		(injected ? findWorkdir(injected, env) : undefined)
	);
}

/** What `add-repo` runs on for the work dir at `root`. */
export function workdirTicketEnv(
	root: string,
	options: {
		/**
		 * Submit text to the agent of a space, found through the stores of its
		 * repo: the work dir's for a ticket's lead agent, a repo's for the agent
		 * of its plain space.
		 */
		tell: (
			stores: StateDaos,
			repo: string,
			key: string,
			text: string,
		) => Promise<string>;
		daos?: (repo: string, mainRoot: string) => StateDaos;
	},
): TicketEnv {
	const workdir = workdirRepoContext(root);
	const repos: RepoContext[] = readWorkdir(root).repos.flatMap(listed => {
		const roots = checkoutAt(listed.root);
		return roots?.name === listed.name ? [repoContextOf(roots)] : [];
	});
	const build =
		options.daos ??
		((repo: string, mainRoot: string) =>
			createStateDaos({repo, mainRoot: () => mainRoot}));
	const built = new Map<string, StateDaos>();
	const daos = (name: string) => {
		let stores = built.get(name);
		if (!stores) {
			const repo =
				name === workdir.name
					? workdir
					: repos.find(each => each.name === name);
			stores = build(name, repo?.mainRoot ?? root);
			built.set(name, stores);
		}

		return stores;
	};

	return ticketEnv({
		workdir,
		repos: () => repos,
		daos,
		tickets: ticketStore(workdir.name),
		tellLead: async (key, text) =>
			options.tell(daos(workdir.name), workdir.name, key, text),
		tellSpace: async (repo, key, text) =>
			options.tell(daos(repo), repo, key, text),
	});
}

export type AddRepoDeps = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** What the command runs on for a work dir; throws when it can't be set up. */
	ticketEnv: (workdirRoot: string) => TicketEnv;
	/**
	 * Run the same command again in a process of its own, which outlives the
	 * session this one runs in.
	 */
	detach: (argv: string[]) => void;
	/** Where the result goes: the terminal, or the log for the detached run. */
	out: (text: string) => void;
	err: (text: string) => void;
};

/** Set on the detached run, so that it does not detach again. */
export const ADD_REPO_DETACHED = 'LASAGNA_ADD_REPO_DETACHED';

/**
 * Whether the agent a message is for is the one that ran this command: it
 * reads the command's output, and is not also told in its pane. The detached
 * run's output goes to the log, so the agent it left behind is told like any
 * other, and hears it when the conversion it asked for could not be done.
 */
export function readsOwnOutput(
	env: NodeJS.ProcessEnv,
	repo: string,
	key: string,
): boolean {
	return (
		!env[ADD_REPO_DETACHED] &&
		env['LASAGNA_SPACE']?.trim() === key &&
		env['LASAGNA_REPO']?.trim() === repo
	);
}

export function describeAddRepo(result: AddRepoResult, repo: string): string {
	const {ticket} = result;
	const lines = [
		result.kind === 'converted'
			? `${ticket.key} is now a ticket space in ${ticket.repos.map(each => each.name).join(' and ')}. Its lead agent runs in ${ticket.folder}`
			: `Added ${repo} to ${ticket.key}: ${ticket.repos.find(each => each.name === repo)?.worktreePath ?? ticket.folder}`,
		...result.warnings.map(warning => `Warning: ${warning}`),
	];
	return lines.join('\n');
}

export async function runAddRepoCommand(
	argv: readonly string[],
	deps: AddRepoDeps,
): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h')) {
		deps.out(ADD_REPO_HELP);
		return 0;
	}

	if (
		argv.length === 0 ||
		argv.length > 2 ||
		argv.some(arg => arg.startsWith('-'))
	) {
		deps.err(ADD_REPO_USAGE);
		return 2;
	}

	// The space this runs in: its sessions carry its key and its repo.
	const ownKey = deps.env['LASAGNA_SPACE']?.trim();
	const ownRepo = deps.env['LASAGNA_REPO']?.trim();
	const own =
		ownKey && ownRepo ? `${ownRepo}:${ownKey}` : (ownKey ?? undefined);
	const [space, repo] = argv.length === 2 ? argv : [own, argv[0]];
	if (!space || !repo) {
		deps.err(`Not in a Lasagna space; name the space. ${ADD_REPO_USAGE}`);
		return 2;
	}

	const root = commandWorkdir(deps.cwd, deps.env);
	if (root === undefined) {
		deps.err(
			'add-repo adds a repo of a work dir, and this directory is in none (no .lasagna/workdir.yml above it)',
		);
		return 2;
	}

	const ref = parseSpaceRef(space);
	const detached = Boolean(deps.env[ADD_REPO_DETACHED]);
	const options = {
		key: ref.key,
		repo,
		// A ticket space is the work dir's own: naming it that way names no
		// plain space to convert.
		...(ref.repo === undefined || isWorkdirRepoName(ref.repo)
			? {}
			: {from: ref.repo}),
	};
	try {
		const env = deps.ticketEnv(root);
		// A plain space this would end may be the one the command runs in: the
		// one converted, or the new repo's own for the same key. Its session
		// ends before its worktree has moved, so the rest has to happen in a
		// process of its own.
		if (
			!detached &&
			ownKey === ref.key &&
			ownRepo !== undefined &&
			!isWorkdirRepoName(ownRepo)
		) {
			// That process has nobody to tell, so what can be refused is refused
			// here, where the caller reads it.
			const {ending} = checkAddRepo(env, options);
			if (ending.includes(ownRepo)) {
				deps.detach([
					options.from ? `${options.from}:${ref.key}` : space,
					repo,
				]);
				deps.out(
					`Making ${ref.key} a ticket space with ${repo}, in the background. A lead agent takes over with a handoff of this conversation, and this session ends when it has started. Finish what you are saying and stop.`,
				);
				return 0;
			}
		}

		const result = await addRepoToSpace(env, options);
		deps.out(describeAddRepo(result, repo));
		return 0;
	} catch (error) {
		// Nobody reads the detached run's output: whatever stops it is said
		// where `err` puts it, which is the log.
		if (!(error instanceof TicketError) && !detached) throw error;
		deps.err(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
