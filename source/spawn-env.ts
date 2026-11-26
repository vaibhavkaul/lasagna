import {isWorkdirRepoName} from './repo-config-files.ts';
import {bunForChildren, isStandalone} from './runtime.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';

/**
 * Build env object for spawning the idow script.
 * Passes LASAGNA_PROJECT_ROOT so the shell scripts resolve config
 * from the user's project directory, not the pappardelle source repo, and
 * LASAGNA_MAIN_REPO_ROOT so nothing downstream re-derives it — idow hands
 * it on to the workspace's tmux sessions, where the Claude Code hooks read it
 * instead of resolving the main checkout on every tool use.
 *
 * `registerSpace` is whether the caller's registry records a space while it
 * is being set up (`SpaceRegistryDao.keepsLifecycle`). Where it does, idow
 * records the space before it starts any session.
 *
 * `env` is the repo's own environment (`RepoContext.env`): the process's,
 * with the repo's `.envrc`. It defaults to the process's alone.
 */
export function buildSpawnEnv(
	repoRoot: string,
	options: {
		mainRepoRoot?: string;
		registerSpace: boolean;
		env?: NodeJS.ProcessEnv;
	},
): NodeJS.ProcessEnv {
	const {mainRepoRoot, registerSpace} = options;
	return {
		...(options.env ?? process.env),
		LASAGNA_BUN: bunForChildren(),
		LASAGNA_EXECUTABLE: isStandalone ? process.execPath : undefined,
		LASAGNA_PROJECT_ROOT: repoRoot,
		LASAGNA_REGISTER_SPACE: registerSpace ? '1' : undefined,
		...(mainRepoRoot ? {LASAGNA_MAIN_REPO_ROOT: mainRepoRoot} : {}),
	};
}

/**
 * Where idow runs for a repo, and with what: in the repo's working tree,
 * with the repo's own environment.
 */
export function idowSpawnOptions(
	repo: {root: string; mainRoot: string; env: NodeJS.ProcessEnv; name?: string},
	registerSpace: boolean,
): {cwd: string; env: NodeJS.ProcessEnv} {
	return {
		cwd: repo.root,
		env: {
			...buildSpawnEnv(repo.root, {
				mainRepoRoot: repo.mainRoot,
				registerSpace,
				env: repo.env,
			}),
			// A work dir is no checkout for idow to read a name off: its spaces
			// (ticket spaces) are kept under the pseudo-repo named here.
			...(repo.name !== undefined && isWorkdirRepoName(repo.name)
				? {LASAGNA_WORKDIR_REPO: repo.name}
				: {}),
		},
	};
}

/**
 * Build the `-e` flags for `tmux new-session` on a space's claude and
 * companion sessions. Mirrors SESSION_ENV in start-agent-session.sh, which
 * covers sessions that idow makes; this covers the ones the TUI makes itself
 * (the main space, and any space whose sessions are gone after a reboot).
 *
 * The variables go on the session because the inner tmux server is long-lived:
 * its global environment is whatever the process that started it had.
 *
 * LASAGNA_REPO qualifies the hook's status file name, since spaces of two
 * repos can share a key and all repos write to one status directory.
 *
 * The main space gets no LASAGNA_SPACE. Without the database the rail
 * keys its dot by the branch, which changes while the session lives on, and
 * the hook's cwd logic follows it. With the database the hook finds main from
 * its stored worktree.
 */
export function buildSessionEnvArgs(
	spaceKey: string,
	repoName: string,
	mainRepoRoot?: string,
): string[] {
	return [
		'-e',
		`LASAGNA_REPO=${repoName}`,
		...(spaceKey === MAIN_WORKTREE_KEY
			? []
			: ['-e', `LASAGNA_SPACE=${spaceKey}`]),
		...(mainRepoRoot ? ['-e', `LASAGNA_MAIN_REPO_ROOT=${mainRepoRoot}`] : []),
	];
}

/**
 * The `-e` flags only the agent session gets, mirroring AGENT_SESSION_ENV in
 * start-agent-session.sh. The agent profile's env comes first, so
 * pappardelle's own variables win a name clash (tmux keeps the last). Pi and
 * agy report their status to the pane monitor only when asked, since tmux
 * cannot answer the terminal probe they would otherwise send; the monitor
 * captures the reports without changing the terminal transport.
 */
export function buildAgentSessionEnvArgs(
	profileEnv: Record<string, string> = {},
): string[] {
	return [
		...Object.entries(profileEnv).flatMap(([name, value]) => [
			'-e',
			`${name}=${value}`,
		]),
		'-e',
		'PI_PROGRAM_STATUS=1',
		'-e',
		'AGY_CLI_OSC7501=on',
	];
}
