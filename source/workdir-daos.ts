// One set of stores over every repo of a work dir. Each repo keeps its own
// stores, keyed by its own space keys; a process that shows the whole work
// dir names a space `repo:KEY`, and these stores send each call to the repo
// the name carries, with the bare key. Code written for one repo (the rail,
// tmux.ts) then serves several without knowing it.

import type {ClaudeStatusDao} from './claude-status.ts';
import type {
	CompanionRequestDao,
	CompanionWidthDao,
} from './companion-width.ts';
import type {HighlightDao} from './highlight.ts';
import type {HoldDao} from './holds.ts';
import type {IssueMetaDao} from './issue-meta.ts';
import type {PaneWidth} from './layout-sizing.ts';
import type {ProgramStatusDao} from './program-status-monitor.ts';
import type {ScheduleDao} from './schedule.ts';
import type {
	SpaceIdentity,
	SpaceIdentityDao,
	SpaceIdentityList,
	SpaceIdentityLookup,
} from './space-identity.ts';
import {formatSpaceRef, parseSpaceRef} from './space-ref.ts';
import type {SpaceRegistryDao} from './space-registry.ts';
import type {
	AgentSessionsDao,
	SpaceStateDao,
	SpaceStatePatch,
} from './space-state.ts';
import type {StateDaos} from './state-daos.ts';

export type RepoStores = {repo: string; daos: StateDaos};

type Routed = {stores: RepoStores; key: string};

/**
 * The stores a work dir's TUI runs on. `own` is the work dir's pseudo-repo:
 * a name that carries no repo is one of its keys, and the stores that are
 * about the TUI itself (its marker, the update check) are its own. A name is
 * written `repo:KEY` for every repo, the pseudo-repo included.
 */
export function workdirStateDaos(
	own: RepoStores,
	repos: readonly RepoStores[],
): StateDaos {
	const all = [own, ...repos];
	const byRepo = new Map(all.map(stores => [stores.repo, stores]));
	const route = (name: string): Routed => {
		const ref = parseSpaceRef(name);
		const stores = ref.repo === undefined ? undefined : byRepo.get(ref.repo);
		return stores ? {stores, key: ref.key} : {stores: own, key: name};
	};

	const named = (stores: RepoStores, key: string) =>
		formatSpaceRef(stores.repo, key);
	const stopAll = (stops: Array<() => void>) => () => {
		for (const stop of stops) stop();
	};

	const registry: SpaceRegistryDao = {
		keepsLifecycle: own.daos.registry.keepsLifecycle,
		openSpaces() {
			let written = false;
			const names: string[] = [];
			for (const stores of all) {
				const keys = stores.daos.registry.openSpaces();
				if (!keys) continue;
				written = true;
				names.push(...keys.map(key => named(stores, key)));
			}

			return written ? names : null;
		},
		async openSpacesAsync() {
			const lists = await Promise.all(
				all.map(async stores => {
					const keys = await stores.daos.registry.openSpacesAsync();
					return keys?.map(key => named(stores, key)) ?? null;
				}),
			);
			return lists.some(Boolean) ? lists.flatMap(names => names ?? []) : null;
		},
		protectedSpaces() {
			const keys: string[] = [];
			for (const stores of all) {
				const owned = stores.daos.registry.protectedSpaces();
				if (!owned.ok) return owned;
				keys.push(...owned.keys.map(key => named(stores, key)));
			}

			return {ok: true, keys};
		},
		has(name) {
			const {stores, key} = route(name);
			return stores.daos.registry.has(key);
		},
		phase(name) {
			const {stores, key} = route(name);
			return stores.daos.registry.phase(key);
		},
		async add(name, signal) {
			const {stores, key} = route(name);
			return stores.daos.registry.add(key, signal);
		},
		async remove(name, signal) {
			const {stores, key} = route(name);
			return stores.daos.registry.remove(key, signal);
		},
		async reserveStart(name, ownerPid) {
			const {stores, key} = route(name);
			return stores.daos.registry.reserveStart(key, ownerPid);
		},
		async markClosing(name) {
			const {stores, key} = route(name);
			return stores.daos.registry.markClosing(key);
		},
		async reopen(name) {
			const {stores, key} = route(name);
			return stores.daos.registry.reopen(key);
		},
		async settle(deps) {
			await Promise.all(
				all.map(async stores =>
					stores.daos.registry.settle({
						closing: {has: key => deps.closing.has(named(stores, key))},
						liveSessions: deps.liveSessions,
					}),
				),
			);
		},
		// A watchlist's issues are one repo's, so its slots are that repo's.
		async tryReserveWatchlistSlots(source, candidateKeys, max, options) {
			const {stores} = route(candidateKeys[0] ?? '');
			const slots = await stores.daos.registry.tryReserveWatchlistSlots(
				source,
				candidateKeys.map(name => route(name).key),
				max,
				options,
			);
			return {
				...slots,
				reserved: slots.reserved.map(key => named(stores, key)),
				claimedElsewhere: slots.claimedElsewhere.map(key => named(stores, key)),
			};
		},
		async releaseWatchlistReservation(name) {
			const {stores, key} = route(name);
			return stores.daos.registry.releaseWatchlistReservation(key);
		},
	};

	const identityStores = (identity: SpaceIdentity) =>
		byRepo.get(identity.repo) ?? own;
	const spaceIdentities: SpaceIdentityDao = {
		get(name): SpaceIdentityLookup {
			const {stores, key} = route(name);
			return stores.daos.spaceIdentities.get(key);
		},
		list(): SpaceIdentityList {
			const identities: SpaceIdentity[] = [];
			for (const stores of all) {
				const listed = stores.daos.spaceIdentities.list();
				if (listed.kind === 'unreadable') return listed;
				identities.push(...listed.identities);
			}

			return {kind: 'identities', identities};
		},
		atPath(at): SpaceIdentityLookup {
			let unreadable: SpaceIdentityLookup | undefined;
			// The repos first: a checkout inside the work dir is its repo's.
			for (const stores of [...repos, own]) {
				const lookup = stores.daos.spaceIdentities.atPath(at);
				if (lookup.kind === 'identity') return lookup;
				if (lookup.kind === 'unreadable') unreadable ??= lookup;
			}

			return unreadable ?? {kind: 'unknown'};
		},
		async record(identity) {
			return identityStores(identity).daos.spaceIdentities.record(identity);
		},
		async moveMain(identity) {
			return identityStores(identity).daos.spaceIdentities.moveMain(identity);
		},
		async respellFormatSessions() {
			await Promise.all(
				all.map(async stores =>
					stores.daos.spaceIdentities.respellFormatSessions(),
				),
			);
		},
	};

	const spaceState: SpaceStateDao = {
		file(name) {
			const {stores, key} = route(name);
			return stores.daos.spaceState.file(key);
		},
		read(name) {
			const {stores, key} = route(name);
			return stores.daos.spaceState.read(key);
		},
		lookup(name) {
			const {stores, key} = route(name);
			return stores.daos.spaceState.lookup(key);
		},
		async write(name, patch) {
			const {stores, key} = route(name);
			return stores.daos.spaceState.write(key, patch);
		},
		async writeMany(entries) {
			const perRepo = new Map<
				RepoStores,
				Array<{key: string; patch: SpaceStatePatch}>
			>();
			for (const entry of entries) {
				const {stores, key} = route(entry.key);
				const mine = perRepo.get(stores) ?? [];
				mine.push({key, patch: entry.patch});
				perRepo.set(stores, mine);
			}

			await Promise.all(
				[...perRepo].map(async ([stores, mine]) =>
					stores.daos.spaceState.writeMany(mine),
				),
			);
		},
		async addPrLink(name, link) {
			const {stores, key} = route(name);
			return stores.daos.spaceState.addPrLink(key, link);
		},
	};

	const agentSessions: AgentSessionsDao = {
		file(name) {
			const {stores, key} = route(name);
			return stores.daos.agentSessions.file(key);
		},
		read(name, agentProfile) {
			const {stores, key} = route(name);
			return stores.daos.agentSessions.read(key, agentProfile);
		},
		sessions(name) {
			const {stores, key} = route(name);
			return stores.daos.agentSessions.sessions(key);
		},
		latestProfile(name) {
			const {stores, key} = route(name);
			return stores.daos.agentSessions.latestProfile(key);
		},
		keys() {
			return all.flatMap(stores =>
				stores.daos.agentSessions.keys().map(key => named(stores, key)),
			);
		},
		async renameProfile(name, from, to) {
			const {stores, key} = route(name);
			return stores.daos.agentSessions.renameProfile(key, from, to);
		},
		async clear(name) {
			const {stores, key} = route(name);
			return stores.daos.agentSessions.clear(key);
		},
	};

	const issueMeta: IssueMetaDao = {
		read(name) {
			const {stores, key} = route(name);
			return stores.daos.issueMeta.read(key);
		},
		async markCreated(name) {
			const {stores, key} = route(name);
			return stores.daos.issueMeta.markCreated(key);
		},
	};

	// `lasagna highlight` writes to the store of the repo it runs in, so
	// the rail watches every repo's and learns the repo from which one spoke.
	const highlight: HighlightDao = {
		async request(request) {
			const {stores, key} = route(request.issueKey);
			return stores.daos.highlight.request({...request, issueKey: key});
		},
		shellRequest(request) {
			const {stores, key} = route(request.issueKey);
			return stores.daos.highlight.shellRequest({...request, issueKey: key});
		},
		watch(listener) {
			return stopAll(
				all.map(stores =>
					stores.daos.highlight.watch(request => {
						listener({
							...request,
							issueKey: named(stores, request.issueKey),
						});
					}),
				),
			);
		},
		async clear() {
			await Promise.all(all.map(async stores => stores.daos.highlight.clear()));
		},
	};

	const companionWidths: CompanionWidthDao = {
		all() {
			const widths: Record<string, PaneWidth> = {};
			for (const stores of all) {
				for (const [key, width] of Object.entries(
					stores.daos.companionWidths.all(),
				))
					widths[named(stores, key)] = width;
			}

			return widths;
		},
		get(name) {
			const {stores, key} = route(name);
			return stores.daos.companionWidths.get(key);
		},
		async set(name, width) {
			const {stores, key} = route(name);
			return stores.daos.companionWidths.set(key, width);
		},
	};

	// A request is answered in the store it was made in.
	const requestedIn = new Map<string, RepoStores>();
	const companionRequests: CompanionRequestDao = {
		async send(request) {
			const {stores, key} = route(request.space);
			return stores.daos.companionRequests.send({...request, space: key});
		},
		answerTo(id) {
			for (const stores of all) {
				const ack = stores.daos.companionRequests.answerTo(id);
				if (ack) return ack;
			}

			return null;
		},
		async withdraw(id) {
			await Promise.all(
				all.map(async stores => stores.daos.companionRequests.withdraw(id)),
			);
		},
		watch(onRequest) {
			return stopAll(
				all.map(stores =>
					stores.daos.companionRequests.watch(request => {
						requestedIn.set(request.id, stores);
						onRequest({...request, space: named(stores, request.space)});
					}),
				),
			);
		},
		async answer(ack) {
			const stores = requestedIn.get(ack.id) ?? own;
			return stores.daos.companionRequests.answer(ack);
		},
	};

	const programStatus: ProgramStatusDao = {
		async attach(name, session, socket, run) {
			const {stores, key} = route(name);
			return stores.daos.programStatus.attach(key, session, socket, run);
		},
		async monitor(name, session, located, socket, run) {
			const {stores, key} = route(name);
			return stores.daos.programStatus.monitor(
				key,
				session,
				located,
				socket,
				run,
			);
		},
		monitored(name, generation) {
			const {stores, key} = route(name);
			return stores.daos.programStatus.monitored(key, generation);
		},
		async read(name, pane) {
			const {stores, key} = route(name);
			return stores.daos.programStatus.read(key, pane);
		},
		async remove(name, keepGeneration) {
			const {stores, key} = route(name);
			return stores.daos.programStatus.remove(key, keepGeneration);
		},
		watch(listener) {
			return stopAll(
				all.map(stores =>
					stores.daos.programStatus.watch(key => {
						listener(named(stores, key));
					}),
				),
			);
		},
		async waitForChange(ms) {
			await Promise.race(
				all.map(async stores => stores.daos.programStatus.waitForChange(ms)),
			);
		},
	};

	// Every repo's wake-ups and holds on one list, each under its space's
	// full name. An id says nothing of its repo, so it is looked for in each.
	const schedules: ScheduleDao = {
		async save(job) {
			const {stores, key} = route(job.key);
			return stores.daos.schedules.save({...job, key});
		},
		load(id) {
			for (const stores of all) {
				const job = stores.daos.schedules.load(id);
				if (job) return {...job, key: named(stores, job.key)};
			}

			return null;
		},
		list() {
			return all.flatMap(stores =>
				stores.daos.schedules
					.list()
					.map(job => ({...job, key: named(stores, job.key)})),
			);
		},
		async delete(id) {
			await Promise.all(
				all
					.filter(stores => stores.daos.schedules.load(id) !== null)
					.map(async stores => stores.daos.schedules.delete(id)),
			);
		},
		async queue(name, text) {
			const {stores, key} = route(name);
			return stores.daos.schedules.queue(key, text);
		},
		queued(name) {
			const {stores, key} = route(name);
			return stores.daos.schedules.queued(key);
		},
		async clearQueued(name) {
			const {stores, key} = route(name);
			return stores.daos.schedules.clearQueued(key);
		},
	};

	const holds: HoldDao = {
		async save(hold) {
			const {stores, key} = route(hold.key);
			return stores.daos.holds.save({...hold, key});
		},
		load(id) {
			for (const stores of all) {
				const hold = stores.daos.holds.load(id);
				if (hold) return {...hold, key: named(stores, hold.key)};
			}

			return null;
		},
		list() {
			return all.flatMap(stores =>
				stores.daos.holds
					.list()
					.map(hold => ({...hold, key: named(stores, hold.key)})),
			);
		},
	};

	// Hook status is kept under repo-qualified keys in one place for every
	// repo, so the work dir's own store reads any repo's.
	const {claudeStatus}: {claudeStatus: ClaudeStatusDao} = own.daos;

	return {
		registry,
		spaceIdentities,
		claudeStatus,
		spaceState,
		issueMeta,
		highlight,
		stateColors: own.daos.stateColors,
		agentSessions,
		companionWidths,
		companionRequests,
		schedules,
		holds,
		prLinkStamp: own.daos.prLinkStamp,
		programStatus,
		tuiMarker: own.daos.tuiMarker,
		updateCheck: own.daos.updateCheck,
		deferCheckpoints() {
			for (const stores of all) stores.daos.deferCheckpoints();
		},
		allowStatusDaemonStart() {
			for (const stores of all) stores.daos.allowStatusDaemonStart();
		},
		disconnectStatusDaemon() {
			for (const stores of all) stores.daos.disconnectStatusDaemon();
		},
	};
}
