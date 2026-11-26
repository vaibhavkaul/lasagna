// What a TUI that shows a whole work dir runs on: every repo the work dir
// lists, set up side by side, behind one set of stores and one answer to
// "which repo is this space in".

import {repoRootsAt, type RepoRoots} from './config.ts';
import {createLogger} from './logger.ts';
import {bootstrapRepo} from './repo-bootstrap.ts';
import {
	repoContextOf,
	workdirRepoContext,
	type RepoContext,
} from './repo-context.ts';
import {sameFile} from './same-file.ts';
import {formatSpaceRef, parseSpaceRef} from './space-ref.ts';
import {
	setSpaceScopes,
	setTicketMembers,
	type TicketMember,
} from './space-scope.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import type {StateDaos} from './state-daos.ts';
import {ticketStore, type TicketStore} from './ticket-space.ts';
import {initTmuxState} from './tmux.ts';
import {workdirStateDaos} from './workdir-daos.ts';
import {readWorkdir, type Workdir} from './workdir.ts';

const log = createLogger('workdir');

/** One of the repos a work dir's rail shows. */
export type WorkdirRepo = {
	name: string;
	context: RepoContext;
	daos: StateDaos;
	/** A few letters that tell it from the other repos on a narrow rail. */
	tag: string;
	/** The work dir's own pseudo-repo, whose only space is the root main space. */
	isWorkdir: boolean;
};

export type WorkdirRuntime = {
	root: string;
	/** The work dir's directory name, as the rail's header shows it. */
	label: string;
	/** The work dir's own pseudo-repo. */
	own: WorkdirRepo;
	/** The repos it lists, in the order its config lists them. */
	repos: WorkdirRepo[];
	/** `own`, then `repos`. */
	all: WorkdirRepo[];
	/** One set of stores over all of them, keyed by `repo:KEY`. */
	daos: StateDaos;
	/** The name of the root main space. */
	rootMain: string;
	repo(name: string): WorkdirRepo | undefined;
	/** The repo a space name carries. */
	repoOf(spaceName: string): WorkdirRepo | undefined;
	/** Which repos each of the work dir's ticket spaces holds. */
	tickets: TicketStore;
	/**
	 * The repos of a ticket space, by its name. Undefined for any other space,
	 * and for a space of the work dir that no ticket folder was made for.
	 */
	ticketMembers(spaceName: string): TicketMember[] | undefined;
};

const TAG_LENGTH = 3;

/**
 * A short tag per repo: its words' initials (`appian-server` is `as`), or its
 * first letters when it is one word. Two repos never share a tag: the later
 * one takes more of its name, then a number.
 */
export function repoTags(names: readonly string[]): Map<string, string> {
	const tags = new Map<string, string>();
	const taken = new Set<string>();
	for (const name of names) {
		const words = name.split(/[^a-z\d]+/i).filter(Boolean);
		const letters = words.join('');
		const candidates = [
			words.length > 1
				? words
						.map(word => word[0])
						.join('')
						.slice(0, TAG_LENGTH)
				: letters.slice(0, 2),
			letters.slice(0, TAG_LENGTH),
			...words.slice(1).map(word => `${letters[0] ?? ''}${word.slice(0, 2)}`),
		]
			.map(candidate => candidate.toLowerCase())
			.filter(Boolean);
		let tag = candidates.find(candidate => !taken.has(candidate));
		for (let n = 2; tag === undefined; n++) {
			const numbered = `${(candidates[0] ?? 'r').slice(0, TAG_LENGTH - 1)}${n}`;
			if (!taken.has(numbered)) tag = numbered;
		}

		taken.add(tag);
		tags.set(name, tag);
	}

	return tags;
}

/**
 * The checkout a listed directory is, or undefined (with a logged reason)
 * when it can't be shown: it is no checkout, it is a directory inside one, or
 * git names it differently from the section that lists it.
 */
function listedCheckout(name: string, root: string): RepoRoots | undefined {
	let roots: RepoRoots;
	try {
		roots = repoRootsAt(root);
	} catch {
		log.warn(
			`${name} is listed in the work dir but ${root} is not a git checkout`,
		);
		return undefined;
	}

	if (!sameFile(roots.root, root) || !sameFile(roots.mainRoot, root)) {
		log.warn(
			`${name} is listed in the work dir but ${root} is not a repo's main checkout`,
		);
		return undefined;
	}

	// State and tmux sessions are kept under the name git gives the checkout.
	if (roots.name !== name) {
		log.warn(
			`${name} is listed in the work dir but its checkout is named ${roots.name}; list it under that name`,
		);
		return undefined;
	}

	return roots;
}

export type WorkdirRepoSetup = (repo: RepoContext) => {daos: StateDaos};

/**
 * Set up every repo of the work dir at `root` beside the process's own
 * (`own`, the work dir's pseudo-repo, already bootstrapped), and from here on
 * read each space's repo off its name.
 */
export function startWorkdir(
	root: string,
	own: {repoName: string; daos: StateDaos},
	options: {
		workdir?: Workdir;
		/** Sets a repo up and hands back its stores. */
		setup?: WorkdirRepoSetup;
		/** The work dir's ticket records; the ones under the default state dir. */
		tickets?: TicketStore;
	} = {},
): WorkdirRuntime {
	const workdir = options.workdir ?? readWorkdir(root);
	const setup = options.setup ?? bootstrapRepo;
	const listed = workdir.repos.flatMap(({name, root: repoRoot}) => {
		const roots = listedCheckout(name, repoRoot);
		return roots ? [{name, context: repoContextOf(roots)}] : [];
	});
	const tags = repoTags(listed.map(({name}) => name));
	const repos: WorkdirRepo[] = listed.map(({name, context}) => ({
		name,
		context,
		daos: setup(context).daos,
		tag: tags.get(name)!,
		isWorkdir: false,
	}));
	const ownRepo: WorkdirRepo = {
		name: own.repoName,
		context: workdirRepoContext(workdir.root),
		daos: own.daos,
		tag: '',
		isWorkdir: true,
	};
	const all = [ownRepo, ...repos];
	const byName = new Map(all.map(repo => [repo.name, repo]));
	const repoOf = (spaceName: string) => {
		const ref = parseSpaceRef(spaceName);
		return ref.repo === undefined ? undefined : byName.get(ref.repo);
	};

	const daos = workdirStateDaos(
		{repo: ownRepo.name, daos: ownRepo.daos},
		repos.map(repo => ({repo: repo.name, daos: repo.daos})),
	);
	initTmuxState(daos);
	setSpaceScopes(spaceName => {
		const repo = repoOf(spaceName);
		return repo && {repo: repo.context, key: parseSpaceRef(spaceName).key};
	});
	const tickets = options.tickets ?? ticketStore(ownRepo.name);
	// A ticket space is a space of the work dir itself that has a ticket
	// folder; its only other space is its main one.
	const ticketMembers = (spaceName: string) => {
		const {key} = parseSpaceRef(spaceName);
		if (repoOf(spaceName) !== ownRepo || key === MAIN_WORKTREE_KEY)
			return undefined;
		return tickets.read(key)?.repos.flatMap(member => {
			const repo = byName.get(member.name);
			return repo
				? [{repo: repo.context, worktreePath: member.worktreePath}]
				: [];
		});
	};

	setTicketMembers(ticketMembers);

	return {
		root: workdir.root,
		label: ownRepo.name.slice(1),
		own: ownRepo,
		repos,
		all,
		daos,
		rootMain: formatSpaceRef(ownRepo.name, MAIN_WORKTREE_KEY),
		repo: name => byName.get(name),
		repoOf,
		tickets,
		ticketMembers,
	};
}
