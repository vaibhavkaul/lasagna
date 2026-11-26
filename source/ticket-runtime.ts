// What ticket-ops.ts runs on in a real process: idow, git and tmux. The rail
// and the CLI build their `TicketEnv` here and add the two things they do
// differently, which are how a space is named and how its sessions are found.

import {execFile} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {createLogger} from './logger.ts';
import {formatTurns, readTurns} from './read-command.ts';
import type {RepoContext} from './repo-context.ts';
import {scriptsDir} from './runtime.ts';
import {legacyAgentSession, type SpaceIdentity} from './space-identity.ts';
import {findLatestSessionJsonl} from './space-state.ts';
import {idowSpawnOptions} from './spawn-env.ts';
import {ticketCompanionSplits} from './ticket-companions.ts';
import type {TicketDaos, TicketEnv} from './ticket-ops.ts';
import type {Ticket, TicketStore} from './ticket-space.ts';
import {
	createCompanionSplit,
	defaultInnerTmuxRunner,
	exactSessionTarget,
	SERVER_GONE,
	type OuterTmuxRunner,
} from './tmux.ts';
import {runWorkspaceSetup} from './workspace-startup.ts';

const log = createLogger('ticket');
const exec = promisify(execFile);

/** How many of a plain agent's turns its handoff carries. */
const HANDOFF_TURNS = 5;

/**
 * End every session a space's identity names: its agent's (under the old
 * name too), its companion's and the companion's splits. A space with no
 * session running has none to end, which is not a failure. Whether it is
 * true is what lets the space's worktree be moved, so a tmux that did not
 * answer counts as sessions still running.
 */
export function endIdentitySessions(
	identity: SpaceIdentity,
	run: OuterTmuxRunner = defaultInnerTmuxRunner,
): boolean {
	const listed = run(['list-sessions', '-F', '#{session_name}']);
	if (listed.error || listed.status !== 0) {
		// With no session running there is no server, and tmux says so. Any
		// other failure (it could not be run, it timed out) says nothing of
		// what is running.
		return (
			!listed.error &&
			listed.status !== null &&
			SERVER_GONE.test(listed.stderr ?? '')
		);
	}

	const {agentSession, companionSession} = identity.tmux;
	const own = new Set([
		agentSession,
		legacyAgentSession(agentSession),
		companionSession,
	]);
	let ended = true;
	for (const name of listed.stdout.split('\n').filter(Boolean)) {
		if (!own.has(name) && !name.startsWith(`${companionSession}~`)) continue;
		const killed = run(['kill-session', '-t', exactSessionTarget(name)]);
		if (killed.error || killed.status !== 0) ended = false;
	}

	return ended;
}

export type TicketRuntime = {
	/** The work dir's pseudo-repo. */
	workdir: RepoContext;
	/** The work dir's repos, in its order. */
	repos: () => RepoContext[];
	daos: (repo: string) => TicketDaos;
	tickets: TicketStore;
	tellLead: TicketEnv['tellLead'];
	/** Defaults to ending the sessions the plain space's identity names. */
	endSessions?: TicketEnv['endSessions'];
	home?: string;
};

export function ticketEnv(runtime: TicketRuntime): TicketEnv {
	const {workdir, daos} = runtime;
	const own = daos(workdir.name);
	return {
		home: runtime.home ?? os.homedir(),
		workdir,
		repos: runtime.repos,
		daos,
		tickets: runtime.tickets,
		async runIdow(args, repo, extraEnv) {
			// Only the lead agent's run makes a space for the registry to hold.
			const options = idowSpawnOptions(
				repo,
				repo === workdir && own.registry.keepsLifecycle,
			);
			return runWorkspaceSetup(path.join(scriptsDir, 'idow'), args, {
				cwd: options.cwd,
				env: {...options.env, ...extraEnv},
			});
		},
		async git(cwd, args) {
			const {stdout} = await exec('git', ['-C', cwd, ...args], {
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024,
			});
			return stdout;
		},
		tellLead: runtime.tellLead,
		endSessions:
			runtime.endSessions ??
			(async (repo, key) => {
				const lookup = daos(repo).spaceIdentities.get(key);
				return lookup.kind === 'identity'
					? endIdentitySessions(lookup.identity)
					: lookup.kind === 'unknown';
			}),
		showCompanions(ticket) {
			showTicketCompanions(ticket, runtime);
		},
		async lastTurns(worktreePath, key) {
			const conversation = await findLatestSessionJsonl(worktreePath);
			if (!conversation) return undefined;
			try {
				return formatTurns(key, readTurns(conversation), HANDOFF_TURNS);
			} catch {
				return undefined;
			}
		},
	};
}

/**
 * Start a companion pane in each repo's worktree, for the repos that have
 * none yet. A ticket whose companion session is not up has them started with
 * it, when the rail first shows the space.
 */
function showTicketCompanions(ticket: Ticket, runtime: TicketRuntime): void {
	const lookup = runtime
		.daos(runtime.workdir.name)
		.spaceIdentities.get(ticket.key);
	if (lookup.kind !== 'identity') return;
	const repos = runtime.repos();
	const members = ticket.repos.flatMap(member => {
		const repo = repos.find(each => each.name === member.name);
		return repo ? [{repo, worktreePath: member.worktreePath}] : [];
	});
	const listed = defaultInnerTmuxRunner([
		'list-sessions',
		'-F',
		'#{session_name}',
	]);
	const running = new Set(
		listed.error || listed.status !== 0 ? [] : listed.stdout.split('\n'),
	);
	const {companionSession} = lookup.identity.tmux;
	if (!running.has(companionSession)) return;
	for (const [index, split] of ticketCompanionSplits(members).entries()) {
		if (running.has(`${companionSession}~${split.name}`)) continue;
		const result = createCompanionSplit(lookup.identity, {
			...split,
			order: Date.now() + index,
		});
		if (!result.ok)
			log.warn(
				`Could not start the companion pane of ${split.name} for ${ticket.key}: ${result.reason}`,
			);
	}
}
