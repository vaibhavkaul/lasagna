import {loadProviderConfigs, readHomeSqliteState} from './config.ts';
import {inlineConfigErrors} from './config-errors.ts';
import {
	createIssueTracker,
	createVcsHost,
	setIssueTitles,
	setOwnRepo,
	setPrLinkStamp,
	setProviderEnv,
	setRepoProviderSources,
	setStateColors,
	setWorkspaceDiscovery,
} from './providers/index.ts';
import {discoverWorkspaceRepositories} from './providers/workspace-repositories.ts';
import {defaultRepoContext, type RepoContext} from './repo-context.ts';
import {
	createStateDaos,
	stateDaosByRepo,
	type StateDaos,
} from './state-daos.ts';
import {recordSqliteState} from './state-flag.ts';
import {initTmuxState} from './tmux.ts';
import {createLogger} from './logger.ts';

const log = createLogger('repo-bootstrap');

export type BootstrappedRepo = {repoName: string; daos: StateDaos};

/** Repos set up beside the process's own, by name. */
const others = new Map<string, BootstrappedRepo>();

/**
 * Per-repo process setup. Without a repo it sets up the one the process was
 * started for (the checkout it runs in), as a CLI verb and the single-repo
 * TUI do. With one it sets up that repo beside it, once however often it is
 * asked: its stores, and what its tracker and VCS host are built from, so
 * `issueTrackerFor(repo.name)` and `vcsHostFor(repo.name)` answer for it. A
 * process that shows a work dir calls it for every repo in the work dir.
 */
export function bootstrapRepo(repo?: RepoContext): BootstrappedRepo {
	return repo ? bootstrapOtherRepo(repo) : bootstrapOwnRepo();
}

function bootstrapOtherRepo(repo: RepoContext): BootstrappedRepo {
	const known = others.get(repo.name);
	if (known) return known;
	const daos = createStateDaos({
		repo: repo.name,
		mainRoot: () => repo.mainRoot,
	});
	const providerCfg = readProviderConfigs(repo);
	const otherDaos = stateDaosByRepo();
	setRepoProviderSources(repo.name, {
		workspaceDiscovery: async (directory, host) =>
			discoverWorkspaceRepositories(directory, host, name =>
				name === repo.name ? daos.spaceState : otherDaos(name).spaceState,
			),
		stateColors: daos.stateColors,
		prLinkStamp: daos.prLinkStamp,
		issueTitles: daos.spaceState,
		// The repo's own keys, never the ones of the repo the process started in.
		env: repo.env,
		cwd: repo.mainRoot,
		trackerConfig: providerCfg.issue_tracker,
		vcsConfig: providerCfg.vcs_host,
	});
	const bootstrapped = {repoName: repo.name, daos};
	others.set(repo.name, bootstrapped);
	return bootstrapped;
}

function readProviderConfigs(repo?: RepoContext): {
	issue_tracker?: ReturnType<typeof loadProviderConfigs>['issue_tracker'];
	vcs_host?: ReturnType<typeof loadProviderConfigs>['vcs_host'];
} {
	// Uses loadProviderConfigs() instead of loadConfig() so that provider
	// initialization succeeds even when unrelated config sections (e.g.
	// profiles) have validation errors.
	try {
		const providerCfg = loadProviderConfigs(repo?.configPaths());
		if (providerCfg.layerErrors.length > 0)
			log.error(
				`The tracker and VCS host settings of a config file that can't be used are ignored: ${inlineConfigErrors(providerCfg.layerErrors)}`,
			);
		return providerCfg;
	} catch (error) {
		log.error(
			'Could not set up the tracker and VCS host; using the defaults',
			error instanceof Error ? error : undefined,
		);
		return {};
	}
}

/**
 * Setup for the repo the process was started for, shared by the TUI and the
 * CLI verbs.
 */
function bootstrapOwnRepo(): BootstrappedRepo {
	// The plain `export KEY=VAL` lines of $REPO_ROOT/.envrc reach the repo's
	// providers, idow and the agents it starts even when lasagna was
	// launched from a shell or tmux server that didn't have direnv hooked: the
	// TUI's bulk GraphQL fetch reads LINCTL_API_KEY from this environment, so
	// it uses the right workspace's key instead of falling back to
	// ~/.linctl-auth.json. In the checkout the process was started in,
	// variables it already has win and .envrc only fills gaps; a process
	// pointed at another repo takes that repo's .envrc first (RepoContext.env).
	// It is an environment of the repo's own, not process.env: a process that
	// serves two repos must not hand one's keys to the other.
	const own = defaultRepoContext();
	setProviderEnv(own.env);

	// Initialize per-repo state directories so state is kept separate
	// from other repos that may also use pappardelle.
	const repoName = own.name;
	const daosByRepo = stateDaosByRepo();
	const daos = daosByRepo(repoName);
	initTmuxState(daos);
	setOwnRepo(repoName);
	setWorkspaceDiscovery(async (directory, host) =>
		discoverWorkspaceRepositories(
			directory,
			host,
			repo => daosByRepo(repo).spaceState,
		),
	);
	setStateColors(daos.stateColors);
	setPrLinkStamp(daos.prLinkStamp);
	setIssueTitles(daos.spaceState);

	try {
		recordSqliteState(readHomeSqliteState());
	} catch {
		// The hooks keep the mode they last read.
	}

	// Initialize provider singletons from config so that all subsequent
	// no-arg calls (e.g. from tracker.ts facade) use the correct provider.
	try {
		const providerCfg = readProviderConfigs();
		createIssueTracker(providerCfg.issue_tracker);
		createVcsHost(providerCfg.vcs_host);
	} catch (error) {
		log.error(
			'Could not set up the tracker and VCS host; using the defaults',
			error instanceof Error ? error : undefined,
		);
	}

	return {repoName, daos};
}
