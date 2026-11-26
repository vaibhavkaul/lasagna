// Provider factory — creates and caches each repo's providers
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {BeadsProvider} from './beads-provider.ts';
import {GitHubProvider, ghExecutor} from './github-provider.ts';
import {GitLabProvider, glabExecutor} from './gitlab-provider.ts';
import {JiraProvider} from './jira-provider.ts';
import {createDefaultLinearGraphQLClient} from './linear-graphql.ts';
import {LinearProvider, type CliExecutor} from './linear-provider.ts';
import {createLogger} from '../logger.ts';
import type {PrLinkStampDao} from '../pr-link-stamp.ts';
import type {SpaceStateDao} from '../space-state.ts';
import {StateColorCache, type StateColorDao} from './state-color-cache.ts';
import type {
	IssueTrackerProvider,
	TrackerIssue,
	TrackerProviderName,
	VcsHostProvider,
	VcsProviderName,
} from './types.ts';
import type {RepositoryDiscovery} from './workspace-repositories.ts';

export type {
	TrackerIssue,
	PRInfo,
	PRLink,
	PipelineStatus,
	RailStatus,
	IssueTrackerProvider,
	TrackerProviderName,
	VcsHostProvider,
	VcsProviderName,
} from './types.ts';

export interface IssueTrackerConfig {
	provider: TrackerProviderName;
	base_url?: string; // Required for Jira
}

export interface VcsHostConfig {
	provider: VcsProviderName;
	host?: string; // For self-hosted GitLab
}

/**
 * What a repo's providers are built from. Startup hands each one over before
 * the provider is first built, wherever that happens.
 */
type ProviderSources = {
	workspaceDiscovery?: RepositoryDiscovery;
	stateColors?: StateColorDao;
	prLinkStamp?: PrLinkStampDao;
	issueTitles?: SpaceStateDao;
	/**
	 * The environment the repo's tracker and VCS commands run in. Unset for
	 * the process's own.
	 */
	env?: NodeJS.ProcessEnv;
	/** The directory those commands run in. Unset for the process's own. */
	cwd?: string;
	/** The repo's `issue_tracker` and `vcs_host`, for a provider built on first use. */
	trackerConfig?: IssueTrackerConfig;
	vcsConfig?: VcsHostConfig;
};

type RepoProviders = ProviderSources & {
	issueTracker?: IssueTrackerProvider;
	issueTrackerKey?: string;
	vcsHost?: VcsHostProvider;
	vcsHostKey?: string;
};

/**
 * The providers of the repo this process was started for, which the
 * functions that name no repo use.
 */
let own: RepoProviders = {};
/** Every repo's providers by repo name, the process's own included once it is named. */
const byRepo = new Map<string, RepoProviders>();

function providersOf(repo?: string): RepoProviders {
	if (repo === undefined) return own;
	let providers = byRepo.get(repo);
	if (!providers) {
		providers = {};
		byRepo.set(repo, providers);
	}

	return providers;
}

/**
 * Name the repo the process was started for, so that `issueTrackerFor` and
 * `vcsHostFor` with that name answer with the same providers as the
 * functions that name no repo.
 */
export function setOwnRepo(repo: string): void {
	byRepo.set(repo, own);
}

/**
 * Hand over what another repo's providers are built from. They are built on
 * first use, by `issueTrackerFor` and `vcsHostFor`.
 */
export function setRepoProviderSources(
	repo: string,
	sources: ProviderSources,
): void {
	Object.assign(providersOf(repo), sources);
}

const log = createLogger('providers');
const execFileAsync = promisify(execFile);

/**
 * How the VCS host finds the repositories in a workspace. The host is built
 * on first use, wherever that is, so startup hands this over beforehand: it
 * is what makes the rail follow a branch recorded by link-pr.
 */
export function setWorkspaceDiscovery(discover: RepositoryDiscovery): void {
	own.workspaceDiscovery = discover;
}

/**
 * Where the issue tracker keeps workflow state colors between runs. Like the
 * discovery above, startup hands it over before the tracker is first built.
 * Without it a tracker remembers colors only while the process lives.
 */
export function setStateColors(dao: StateColorDao): void {
	own.stateColors = dao;
}

/**
 * Where `lasagna link-pr` records that a PR was just linked, which ends
 * GitHub's failure backoff early. Handed over at startup like the two above.
 * Without it a failed lookup waits out its backoff.
 */
export function setPrLinkStamp(dao: PrLinkStampDao): void {
	own.prLinkStamp = dao;
}

/**
 * Where each space's issue title is kept, so that `lasagna space get`
 * answers with it without calling the tracker. Handed over at startup like
 * the stores above. Without it titles are not kept.
 */
export function setIssueTitles(dao: SpaceStateDao): void {
	own.issueTitles = dao;
}

/**
 * The environment the process's own tracker and VCS commands run in: its
 * repo's `.envrc` on top of the process's. Handed over at startup like the
 * stores above. Without it they inherit the process's environment.
 */
export function setProviderEnv(env: NodeJS.ProcessEnv): void {
	own.env = env;
}

/**
 * Keep the titles of issues just read from the tracker, by space key. Only
 * titles that changed are written, since the rail reads every space's issue
 * on each refresh. A failed read (null) leaves the stored title alone.
 */
export async function recordIssueTitles(
	issues: Iterable<[key: string, issue: TrackerIssue | null]>,
	repo?: string,
): Promise<void> {
	const dao = providersOf(repo).issueTitles;
	if (!dao) return;
	const changed = [...issues].flatMap(([key, issue]) => {
		if (!issue) return [];
		// A record that cannot be read is not overwritten: the write would
		// replace it with the title alone and lose the space's profile and PR links.
		const stored = dao.lookup(key);
		if (stored.kind === 'unreadable') return [];
		if (stored.kind === 'state' && stored.state.issueTitle === issue.title)
			return [];
		return [{key, patch: {issueTitle: issue.title}}];
	});
	if (changed.length === 0) return;
	try {
		await dao.writeMany(changed);
	} catch (error) {
		log.warn(
			'Could not store issue titles',
			error instanceof Error ? error : undefined,
		);
	}
}

function trackerKey(config?: IssueTrackerConfig): string {
	const provider = config?.provider ?? 'linear';
	if (provider === 'jira') return `jira:${config?.base_url ?? ''}`;
	if (provider === 'beads') return 'beads';
	return 'linear';
}

function vcsKey(config?: VcsHostConfig): string {
	const provider = config?.provider ?? 'github';
	return provider === 'gitlab' ? `gitlab:${config?.host ?? ''}` : 'github';
}

/**
 * Runs a tracker CLI in a repo's own environment and directory. Without
 * either, the command inherits the process's, as it always has.
 */
function cliExecutor(sources: ProviderSources): CliExecutor | undefined {
	const {env, cwd} = sources;
	if (!env && !cwd) return undefined;
	return async (cmd, args, opts) => {
		const {stdout} = await execFileAsync(cmd, args, {
			...opts,
			...(cwd ? {cwd} : {}),
			...(env ? {env} : {}),
		});
		return stdout;
	};
}

function buildIssueTracker(
	config: IssueTrackerConfig | undefined,
	sources: ProviderSources,
): IssueTrackerProvider {
	const provider = config?.provider ?? 'linear';

	switch (provider) {
		case 'linear': {
			return new LinearProvider(
				cliExecutor(sources),
				undefined,
				new StateColorCache(sources.stateColors),
				createDefaultLinearGraphQLClient(sources.env),
			);
		}

		case 'jira': {
			if (!config?.base_url) {
				throw new Error(
					'issue_tracker.base_url is required when provider is "jira"',
				);
			}

			return new JiraProvider(
				config.base_url,
				cliExecutor(sources),
				undefined,
				new StateColorCache(sources.stateColors),
			);
		}

		case 'beads': {
			const {cwd, env} = sources;
			return new BeadsProvider(
				undefined,
				undefined,
				new StateColorCache(sources.stateColors),
				cwd ? () => cwd : undefined,
				env,
			);
		}

		// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
		default: {
			throw new Error(
				`Unknown issue tracker provider: "${provider as string}"`,
			);
		}
	}
}

function issueTrackerOf(
	providers: RepoProviders,
	config?: IssueTrackerConfig,
): IssueTrackerProvider {
	// No config: return existing singleton without key checking
	if (!config && providers.issueTracker) {
		return providers.issueTracker;
	}

	const key = trackerKey(config);

	if (providers.issueTracker) {
		if (providers.issueTrackerKey !== key) {
			throw new Error(
				`Issue tracker already initialized as "${providers.issueTrackerKey}" — cannot re-initialize as "${key}". Call resetProviders() first.`,
			);
		}

		return providers.issueTracker;
	}

	providers.issueTracker = buildIssueTracker(config, providers);
	providers.issueTrackerKey = key;
	return providers.issueTracker;
}

/**
 * Create (or return cached) issue tracker provider.
 * When called without config, returns the existing singleton if one was
 * already initialized (regardless of provider type). Only defaults to
 * Linear when no singleton exists and no config is provided.
 * Throws if called with an explicit config that differs from the cached instance.
 */
export function createIssueTracker(
	config?: IssueTrackerConfig,
): IssueTrackerProvider {
	return issueTrackerOf(own, config);
}

/**
 * The issue tracker of a repo by name, built on first use from the config
 * handed to `setRepoProviderSources`. The process's own repo answers with
 * the tracker `createIssueTracker` returns.
 */
export function issueTrackerFor(repo: string): IssueTrackerProvider {
	const providers = providersOf(repo);
	if (providers.issueTracker) return providers.issueTracker;
	try {
		return issueTrackerOf(providers, providers.trackerConfig);
	} catch (error) {
		reportUnusable(repo, 'issue tracker', error);
		providers.trackerConfig = undefined;
		return issueTrackerOf(providers);
	}
}

/**
 * One repo's settings that no provider can be built from (a Jira tracker
 * with no base_url, a provider nobody knows) are that repo's problem alone:
 * a rail that shows several repos asks for each one's providers on every
 * refresh, and must not fall over because of one. The repo is named once in
 * the rail's errors and gets the default provider, which is what the
 * process's own repo gets at startup.
 */
function reportUnusable(repo: string, what: string, error: unknown): void {
	log.error(
		`The ${what} of ${repo} could not be set up; using the default: ${error instanceof Error ? error.message : String(error)}`,
	);
}

function buildVcsHost(
	config: VcsHostConfig | undefined,
	sources: ProviderSources,
): VcsHostProvider {
	const provider = config?.provider ?? 'github';
	const {env, cwd} = sources;
	const scoped = env || cwd ? {env, cwd} : undefined;

	switch (provider) {
		case 'github': {
			const stamp = sources.prLinkStamp;
			return new GitHubProvider(
				scoped && ghExecutor(scoped),
				undefined,
				sources.workspaceDiscovery,
				stamp ? {linkedAt: () => stamp.read()} : {},
				env,
			);
		}

		case 'gitlab': {
			return new GitLabProvider(
				config?.host,
				scoped && glabExecutor(config?.host, scoped),
				undefined,
				sources.workspaceDiscovery,
				env,
			);
		}

		// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
		default: {
			throw new Error(`Unknown VCS host provider: "${provider as string}"`);
		}
	}
}

function vcsHostOf(
	providers: RepoProviders,
	config?: VcsHostConfig,
): VcsHostProvider {
	// No config: return existing singleton without key checking
	if (!config && providers.vcsHost) {
		return providers.vcsHost;
	}

	const key = vcsKey(config);

	if (providers.vcsHost) {
		if (providers.vcsHostKey !== key) {
			throw new Error(
				`VCS host already initialized as "${providers.vcsHostKey}" — cannot re-initialize as "${key}". Call resetProviders() first.`,
			);
		}

		return providers.vcsHost;
	}

	providers.vcsHost = buildVcsHost(config, providers);
	providers.vcsHostKey = key;
	return providers.vcsHost;
}

/**
 * Create (or return cached) VCS host provider.
 * When called without config, returns the existing singleton if one was
 * already initialized. Only defaults to GitHub when no singleton exists
 * and no config is provided.
 * Throws if called with an explicit config that differs from the cached instance.
 */
export function createVcsHost(config?: VcsHostConfig): VcsHostProvider {
	return vcsHostOf(own, config);
}

/** The VCS host of a repo by name, as `issueTrackerFor` is its tracker. */
export function vcsHostFor(repo: string): VcsHostProvider {
	const providers = providersOf(repo);
	if (providers.vcsHost) return providers.vcsHost;
	try {
		return vcsHostOf(providers, providers.vcsConfig);
	} catch (error) {
		reportUnusable(repo, 'VCS host', error);
		providers.vcsConfig = undefined;
		return vcsHostOf(providers);
	}
}

/**
 * Reset all cached provider instances (useful for tests).
 */
export function resetProviders(): void {
	own = {};
	byRepo.clear();
}
