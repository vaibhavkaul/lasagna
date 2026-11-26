// The rail's list for a whole work dir: one WorkspaceRefresh per repo, each
// reading its repo's registry and tracker in that repo's own keys, merged
// into one list whose spaces are named `repo:KEY`.

import type {ClaudeStatusDao} from './claude-status.ts';
import {spaceStatusKey} from './claude-status.ts';
import type {PappardelleConfig} from './config.ts';
import type {ProgramStatusInfo} from './program-status.ts';
import {issueTrackerFor, recordIssueTitles} from './providers/index.ts';
import type {SettleDeps} from './space-registry.ts';
import {formatSpaceRef} from './space-ref.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import type {SpaceData, TrackerIssue} from './types.ts';
import type {WorkdirRepo, WorkdirRuntime} from './workdir-runtime.ts';
import {WorkspaceRefresh} from './workspace-refresh.ts';
import type {StatusReader} from './workspace-status.ts';

type MainWorktree = {path: string; branch: string};

export type WorkdirRefreshDeps = {
	detailReady?: Promise<void>;
	/** A reader whose reads share one tmux listing, keyed by space name. */
	statusReader: () => StatusReader;
	claudeStatus: Pick<ClaudeStatusDao, 'readableKey' | 'mainKeyedByBranch'>;
	/** What `settle` needs, in space names. */
	settle: SettleDeps;
	readWorktreePath: (name: string) => Promise<string | null>;
	/** A checkout's path and branch, read in that checkout. */
	readMainWorktree: (mainRoot: string) => Promise<MainWorktree | null>;
	readDirty: (path: string) => Promise<boolean | null>;
	/** A repo's profile emoji for a space, from that repo's config. */
	readEmoji: (
		repo: WorkdirRepo,
		config: PappardelleConfig | null,
		key: string | undefined,
		issue: TrackerIssue | null,
	) => string | undefined;
	/** A repo's config, read once like the TUI's own. */
	readConfig: (repo: WorkdirRepo) => PappardelleConfig | null;
	onSettleError: (repo: WorkdirRepo, error: unknown) => void;
	setSpaces: (update: (spaces: SpaceData[]) => SpaceData[]) => void;
	onLoaded: () => void;
	onError: (error: unknown) => void;
};

/**
 * `WorkspaceRefresh` over every repo of a work dir. Each repo's refresh sees
 * only its own spaces, under their own keys; what it publishes lands in the
 * shared list under `repo:KEY`, beside whatever the rail itself has set on a
 * space since (its PR status).
 */
export class WorkdirRefresh {
	private readonly refreshes: WorkspaceRefresh[];
	private readonly order: Map<string, number>;
	// The same space under both names, each way, so a space neither side
	// changed stays one object and nothing downstream redraws it.
	private readonly bareOf = new WeakMap<SpaceData, SpaceData>();
	private readonly namedOf = new WeakMap<SpaceData, SpaceData>();
	private reader: StatusReader | undefined;
	private readonly loaded = new Set<string>();

	constructor(
		private readonly runtime: Pick<WorkdirRuntime, 'all' | 'repos'>,
		private readonly deps: WorkdirRefreshDeps,
	) {
		this.order = new Map(runtime.all.map((repo, index) => [repo.name, index]));
		this.refreshes = runtime.all.map(repo => this.refreshOf(repo));
	}

	async refresh(): Promise<void> {
		// One tmux listing serves every repo's status reads of this round.
		this.reader = undefined;
		await Promise.all(this.refreshes.map(async each => each.refresh()));
	}

	/** Invalidate a snapshot taken before a local registry mutation. */
	async refreshListOnly(): Promise<void> {
		this.reader = undefined;
		await Promise.all(this.refreshes.map(async each => each.refreshListOnly()));
	}

	applyStatusUpdates(updates: ReadonlyMap<string, ProgramStatusInfo>): void {
		// Status keys are qualified by repo, so each update matches one repo's
		// space and the others pass it by.
		for (const each of this.refreshes) each.applyStatusUpdates(updates);
	}

	stop(): void {
		for (const each of this.refreshes) each.stop();
	}

	async idle(): Promise<void> {
		await Promise.all(this.refreshes.map(async each => each.idle()));
	}

	private sharedReader(): StatusReader {
		this.reader ??= this.deps.statusReader();
		return this.reader;
	}

	private refreshOf(repo: WorkdirRepo): WorkspaceRefresh {
		const {deps} = this;
		const named = (key: string) => formatSpaceRef(repo.name, key);
		const config = deps.readConfig(repo);
		const tracker = () => issueTrackerFor(repo.name);
		return new WorkspaceRefresh({
			detailReady: deps.detailReady,
			async readRegistry() {
				await repo.daos.registry
					.settle({
						closing: {has: key => deps.settle.closing.has(named(key))},
						liveSessions: deps.settle.liveSessions,
					})
					.catch((error: unknown) => {
						deps.onSettleError(repo, error);
					});
				return repo.daos.registry.openSpacesAsync();
			},
			statusReader: () => async (statusKey, key) =>
				this.sharedReader()(statusKey, named(key)),
			readWorktreePath: async key => deps.readWorktreePath(named(key)),
			// The work dir is no checkout: its main space is its root.
			readMainWorktree: repo.isWorkdir
				? async () => ({path: repo.context.root, branch: MAIN_WORKTREE_KEY})
				: async () => deps.readMainWorktree(repo.context.mainRoot),
			readDirty: repo.isWorkdir ? async () => null : deps.readDirty,
			statusKey: async (key, mainBranch) =>
				spaceStatusKey(
					deps.claudeStatus,
					repo.name,
					key,
					async () => mainBranch,
				),
			getCachedIssue: key => tracker().getIssueCached(key),
			async fetchIssues(keys) {
				const issues = await tracker().getIssues(keys);
				await recordIssueTitles(issues, repo.name);
			},
			readEmoji: async (key, issue) => deps.readEmoji(repo, config, key, issue),
			setSpaces: update => {
				this.publish(repo, update);
			},
			onLoaded: () => {
				this.loaded.add(repo.name);
				// The rail waits for every repo, so it is not drawn half full.
				if (this.loaded.size === this.runtime.all.length) deps.onLoaded();
			},
			onError: deps.onError,
		});
	}

	private publish(
		repo: WorkdirRepo,
		update: (spaces: SpaceData[]) => SpaceData[],
	): void {
		this.deps.setSpaces(merged => {
			const mine = merged.filter(space => space.repo === repo.name);
			const previous = mine.map(space => this.bare(space));
			const next = update(previous);
			if (next === previous) return merged;
			const named = next.map(space => this.named(repo, space));
			if (
				named.length === mine.length &&
				named.every((space, index) => space === mine[index])
			)
				return merged;
			return this.ordered([
				...merged.filter(space => space.repo !== repo.name),
				...named,
			]);
		});
	}

	/** The work dir's own main space first, then each repo's spaces together. */
	private ordered(spaces: SpaceData[]): SpaceData[] {
		const rank = (space: SpaceData) =>
			this.order.get(space.repo ?? '') ?? this.order.size;
		return spaces
			.map((space, index) => ({space, index}))
			.sort((a, b) => rank(a.space) - rank(b.space) || a.index - b.index)
			.map(({space}) => space);
	}

	private named(repo: WorkdirRepo, bare: SpaceData): SpaceData {
		let space = this.namedOf.get(bare);
		if (!space) {
			space = {
				...bare,
				name: formatSpaceRef(repo.name, bare.name),
				repo: repo.name,
				key: bare.name,
				// One repo needs no telling apart, and a main space's row is
				// already called by its repo.
				repoTag:
					this.runtime.repos.length > 1 && !bare.isMainWorktree
						? repo.tag
						: undefined,
			};
			this.namedOf.set(bare, space);
			this.bareOf.set(space, bare);
		}

		return space;
	}

	private bare(space: SpaceData): SpaceData {
		let bare = this.bareOf.get(space);
		if (!bare) {
			const {repo: _repo, key, repoTag: _tag, ...rest} = space;
			bare = {...rest, name: key ?? space.name};
			this.bareOf.set(space, bare);
			this.namedOf.set(bare, space);
		}

		return bare;
	}
}
