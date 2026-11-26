// A ticket space: one ticket worked on in several repos by one lead agent.
// Its agent runs in a ticket folder, `~/.lasagna/worktrees/_tickets/<KEY>/`, which
// holds a real git worktree of each repo (`<KEY>/<repo>/`, on the branch
// `<KEY>`), so one search reaches all of them. The space itself belongs to no
// repo: it is a space of the work dir's pseudo-repo (`@<workdir>`), whose
// worktree is the folder, and which repos it holds is recorded beside that
// pseudo-repo's other state.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sameFile} from './same-file.ts';
import {TICKETS_DIR, worktreePathFor} from './space-identity.ts';
import {DEFAULT_STATE_DIR} from './state-db.ts';
import {STATE_DIR_NAME} from './state-dir.ts';

/** One repo of a ticket space. */
export type TicketRepo = {
	/** The repo's name in the work dir. */
	name: string;
	/**
	 * Its worktree for the ticket: inside the folder, under the repo's name.
	 * A plain space's worktree that could not be moved in stays where it was.
	 */
	worktreePath: string;
};

export type Ticket = {
	key: string;
	/** The folder the lead agent runs in. */
	folder: string;
	/** Its repos, in the order they were added. */
	repos: TicketRepo[];
};

/** Where every ticket folder is: `~/.lasagna/worktrees/_tickets`. */
export function ticketsDir(home: string = os.homedir()): string {
	return path.join(home, STATE_DIR_NAME, 'worktrees', TICKETS_DIR);
}

/**
 * A ticket's folder. It is where a space of a work dir's pseudo-repo has its
 * worktree, so the stores find it like any other space's.
 */
export function ticketFolder(home: string, workdirRepo: string, key: string) {
	return worktreePathFor(home, workdirRepo, key);
}

/** Where a repo's worktree goes in a ticket folder. */
export function memberWorktree(folder: string, repo: string): string {
	return path.join(folder, repo);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTicket(content: string): Ticket | undefined {
	let record: unknown;
	try {
		record = JSON.parse(content);
	} catch {
		return undefined;
	}

	if (!isRecord(record)) return undefined;
	const {key, folder, repos} = record;
	if (typeof key !== 'string' || typeof folder !== 'string') return undefined;
	return {
		key,
		folder,
		repos: (Array.isArray(repos) ? repos : []).flatMap((repo: unknown) =>
			isRecord(repo) &&
			typeof repo['name'] === 'string' &&
			typeof repo['worktreePath'] === 'string'
				? [{name: repo['name'], worktreePath: repo['worktreePath']}]
				: [],
		),
	};
}

/**
 * The repos of each ticket space of one work dir, a file per ticket under
 * the pseudo-repo's state: `~/.lasagna/repos/@<workdir>/tickets/`. It
 * outlives the space being closed, as the worktrees do, so reopening the
 * ticket finds its repos again.
 */
export class TicketStore {
	constructor(private readonly dir: string) {}

	/** The file that records a ticket, for messages that name it. */
	file(key: string): string {
		return path.join(this.dir, `${encodeURIComponent(key)}.json`);
	}

	/** Undefined for a key that is no ticket space, or whose record is unusable. */
	read(key: string): Ticket | undefined {
		try {
			return parseTicket(fs.readFileSync(this.file(key), 'utf8'));
		} catch {
			return undefined;
		}
	}

	list(): Ticket[] {
		let names: string[];
		try {
			names = fs.readdirSync(this.dir);
		} catch {
			return [];
		}

		return names
			.filter(name => name.endsWith('.json'))
			.sort()
			.flatMap(name => {
				try {
					return (
						parseTicket(fs.readFileSync(path.join(this.dir, name), 'utf8')) ??
						[]
					);
				} catch {
					return [];
				}
			});
	}

	/** Replace a ticket's record. A reader sees the old one or the new one. */
	write(ticket: Ticket): void {
		fs.mkdirSync(this.dir, {recursive: true});
		const file = this.file(ticket.key);
		const partial = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(partial, `${JSON.stringify(ticket, null, 2)}\n`);
		fs.renameSync(partial, file);
	}

	remove(key: string): void {
		fs.rmSync(this.file(key), {force: true});
	}
}

/** The ticket records of a work dir's pseudo-repo. */
export function ticketStore(
	workdirRepo: string,
	stateDir: string = DEFAULT_STATE_DIR,
): TicketStore {
	return new TicketStore(path.join(stateDir, 'repos', workdirRepo, 'tickets'));
}

/** `ticket` with `repo` added, or moved to a new worktree. */
export function withTicketRepo(ticket: Ticket, repo: TicketRepo): Ticket {
	const known = ticket.repos.some(each => each.name === repo.name);
	return {
		...ticket,
		repos: known
			? ticket.repos.map(each => (each.name === repo.name ? repo : each))
			: [...ticket.repos, repo],
	};
}

/**
 * The ticket folder holding a directory: the nearest directory at or above
 * it that sits directly in `~/.lasagna/worktrees/_tickets`. A session started in one
 * of a ticket's repos is still in the ticket.
 */
export function ticketFolderAt(
	directory: string,
	home: string = os.homedir(),
): {key: string; folder: string} | undefined {
	const tickets = ticketsDir(home);
	let current: string;
	try {
		current = fs.realpathSync(directory);
	} catch {
		return undefined;
	}

	for (;;) {
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		if (sameFile(parent, tickets))
			return {key: path.basename(current), folder: current};
		current = parent;
	}
}
