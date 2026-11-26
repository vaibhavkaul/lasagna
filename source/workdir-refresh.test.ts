import {test, expect, beforeEach} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {clearRecentErrors, getRecentErrors} from './logger.ts';
import type {ProgramStatusInfo} from './program-status.ts';
import {
	issueTrackerFor,
	resetProviders,
	setRepoProviderSources,
} from './providers/index.ts';
import type {SpaceRegistryDao} from './space-registry.ts';
import type {SpaceData, TrackerIssue} from './types.ts';
import {WorkdirRefresh, type WorkdirRefreshDeps} from './workdir-refresh.ts';
import type {WorkdirRepo, WorkdirRuntime} from './workdir-runtime.ts';

beforeEach(() => {
	resetProviders();
});

const issue = (key: string, title = key): TrackerIssue => ({
	identifier: key,
	title,
	url: '',
	state: {name: 'Open', type: 'unstarted', color: '#fff'},
});

/** A repo whose registry lists `keys`, and whose tracker titles each issue by repo. */
function repo(
	name: string,
	keys: string[] | null,
	options: {isWorkdir?: boolean; tag?: string} = {},
): WorkdirRepo & {keys: string[] | null; fetched: string[][]} {
	const made = {
		name,
		tag: options.tag ?? name.slice(0, 2),
		isWorkdir: options.isWorkdir ?? false,
		keys,
		fetched: [] as string[][],
		context: {root: `/work/${name}`, mainRoot: `/work/${name}`, name},
		daos: {
			registry: {
				async settle() {},
				openSpacesAsync: async () => made.keys,
			} as unknown as SpaceRegistryDao,
		},
	};
	setRepoProviderSources(name, {});
	const tracker = issueTrackerFor(name);
	tracker.getIssueCached = key => issue(key, `${key} of ${name}`);
	tracker.getIssues = async wanted => {
		made.fetched.push(wanted);
		return new Map(wanted.map(key => [key, issue(key, `${key} of ${name}`)]));
	};
	return made as unknown as WorkdirRepo & typeof made;
}

function setup(
	repos: WorkdirRepo[],
	overrides: Partial<WorkdirRefreshDeps> = {},
	/** The repos of each ticket space, by its name. */
	tickets: Record<string, string[]> = {},
) {
	const [own, ...listed] = repos;
	const runtime: Pick<WorkdirRuntime, 'all' | 'repos'> &
		Pick<WorkdirRuntime, 'ticketMembers' | 'repo'> = {
		all: repos,
		repos: listed,
		repo: name => repos.find(each => each.name === name),
		ticketMembers: name =>
			tickets[name]?.map(member => ({
				repo: repos.find(each => each.name === member)!.context,
				worktreePath: `/tickets/${member}`,
			})),
	};
	let spaces: SpaceData[] = [];
	let loaded = 0;
	const errors: unknown[] = [];
	const statusReads: string[] = [];
	const deps: WorkdirRefreshDeps = {
		statusReader: () => async (statusKey, name) => {
			statusReads.push(`${statusKey} <- ${name}`);
			return {status: 'idle'};
		},
		claudeStatus: {
			mainKeyedByBranch: false,
			readableKey: async (repoName, name) => `${repoName}-${name}`,
		},
		settle: {closing: new Set(), liveSessions: () => new Set()},
		readWorktreePath: async name => `/worktrees/${name}`,
		readMainWorktree: async mainRoot => ({path: mainRoot, branch: 'master'}),
		readDirty: async () => false,
		readEmoji: () => undefined,
		readConfig: () => null,
		onSettleError() {},
		setSpaces(update) {
			spaces = update(spaces);
		},
		onLoaded() {
			loaded++;
		},
		onError(error) {
			errors.push(error);
		},
		...overrides,
	};
	const refresh = new WorkdirRefresh(runtime, deps);
	teardown(() => refresh.stop());
	return {
		refresh,
		errors,
		statusReads,
		own: own!,
		get spaces() {
			return spaces;
		},
		get loaded() {
			return loaded;
		},
		set(update: (spaces: SpaceData[]) => SpaceData[]) {
			spaces = update(spaces);
		},
		async settle() {
			await refresh.refresh();
			await refresh.idle();
		},
	};
}

const twoRepos = () => [
	repo('@work', null, {isWorkdir: true, tag: ''}),
	repo('api', ['STA-1', 'STA-9']),
	repo('web', ['STA-1']),
];

test('every repo’s spaces land in one list, named repo:KEY, with the work dir’s own main space first', async () => {
	const h = setup(twoRepos());
	await h.settle();
	expect(h.errors).toEqual([]);
	expect(h.spaces.map(space => space.name)).toEqual([
		'@work:main',
		'api:main',
		'api:STA-9',
		'api:STA-1',
		'web:main',
		'web:STA-1',
	]);
});

test('a repo whose tracker cannot be built still shows its spaces, and the other repos keep theirs', async () => {
	clearRecentErrors();
	teardown(clearRecentErrors);
	// Listed with a Jira tracker and no base_url: nothing can be built from
	// that, and the rail asks for the tracker inside its state updates.
	const bad = {
		name: 'bad',
		tag: 'ba',
		isWorkdir: false,
		context: {root: '/work/bad', mainRoot: '/work/bad', name: 'bad'},
		daos: {
			registry: {
				async settle() {},
				openSpacesAsync: async () => ['BAD-1'],
			} as unknown as SpaceRegistryDao,
		},
	} as unknown as WorkdirRepo;
	setRepoProviderSources('bad', {trackerConfig: {provider: 'jira'}, env: {}});
	const h = setup([...twoRepos(), bad]);
	await h.settle();
	expect(h.errors).toEqual([]);
	expect(h.spaces.map(space => space.name)).toEqual([
		'@work:main',
		'api:main',
		'api:STA-9',
		'api:STA-1',
		'web:main',
		'web:STA-1',
		'bad:main',
		'bad:BAD-1',
	]);
	// The others still have their issues, and the repo is named once.
	expect(
		h.spaces.find(space => space.name === 'web:STA-1')?.linearIssue?.title,
	).toBe('STA-1 of web');
	expect(getRecentErrors().map(entry => entry.message)).toEqual([
		'The issue tracker of bad could not be set up; using the default: issue_tracker.base_url is required when provider is "jira"',
	]);
});

test('a space carries its repo, its own key and its repo’s tag', async () => {
	const h = setup(twoRepos());
	await h.settle();
	const space = h.spaces.find(each => each.name === 'web:STA-1')!;
	expect(space.repo).toBe('web');
	expect(space.key).toBe('STA-1');
	expect(space.repoTag).toBe('we');
	// A main space is called by its repo already, and the root is no repo's.
	expect(
		h.spaces.find(each => each.name === 'api:main')?.repoTag,
	).toBeUndefined();
	expect(h.spaces[0]?.repo).toBe('@work');
	expect(h.spaces[0]?.repoTag).toBeUndefined();
});

test('a work dir with one repo shows no tags', async () => {
	const h = setup([
		repo('@work', null, {isWorkdir: true, tag: ''}),
		repo('api', ['STA-1']),
	]);
	await h.settle();
	expect(
		h.spaces.find(each => each.name === 'api:STA-1')?.repoTag,
	).toBeUndefined();
});

test('the same key in two repos is two spaces, each with its own repo’s issue', async () => {
	const h = setup(twoRepos());
	await h.settle();
	const title = (name: string) =>
		h.spaces.find(each => each.name === name)?.linearIssue?.title;
	expect(title('api:STA-1')).toBe('STA-1 of api');
	expect(title('web:STA-1')).toBe('STA-1 of web');
});

test('each repo’s tracker is asked for its own keys only', async () => {
	const repos = twoRepos();
	const h = setup(repos);
	await h.settle();
	const fetched = (name: string) =>
		repos.find(each => each.name === name)!.fetched;
	expect(
		fetched('api').every(keys => keys.every(key => !key.includes(':'))),
	).toBe(true);
	expect(new Set(fetched('api').flat())).toEqual(new Set(['STA-9', 'STA-1']));
	expect(new Set(fetched('web').flat())).toEqual(new Set(['STA-1']));
});

test('the work dir’s own main space is its root, and a repo’s is its main checkout', async () => {
	const h = setup(twoRepos());
	await h.settle();
	const path = (name: string) =>
		h.spaces.find(each => each.name === name)?.worktreePath;
	expect(path('@work:main')).toBe('/work/@work');
	expect(path('api:main')).toBe('/work/api');
	// A space's worktree is looked up by the name the stores route on.
	expect(path('web:STA-1')).toBe('/worktrees/web:STA-1');
});

test('status is read under each repo’s own status key, through the space’s name', async () => {
	const h = setup(twoRepos());
	await h.settle();
	expect(h.statusReads).toContain('api-STA-1 <- api:STA-1');
	expect(h.statusReads).toContain('web-STA-1 <- web:STA-1');
	expect(h.statusReads).toContain('@work-main <- @work:main');
	expect(h.spaces.find(each => each.name === 'web:STA-1')?.statusKey).toBe(
		'web-STA-1',
	);
});

test('a status update reaches the one space whose status key it carries', async () => {
	const h = setup(twoRepos());
	await h.settle();
	const working: ProgramStatusInfo = {status: 'working'};
	h.refresh.applyStatusUpdates(new Map([['web-STA-1', working]]));
	const status = (name: string) =>
		h.spaces.find(each => each.name === name)?.programStatus?.status;
	expect(status('web:STA-1')).toBe('working');
	expect(status('api:STA-1')).toBe('idle');
});

test('what the rail set on a space survives the next refresh', async () => {
	const h = setup(twoRepos());
	await h.settle();
	// The PR status poll writes straight into the list.
	h.set(spaces =>
		spaces.map(space =>
			space.name === 'api:STA-1'
				? {
						...space,
						railStatus: {pipeline: 'passing', unresolvedCommentCount: 2},
					}
				: space,
		),
	);
	await h.settle();
	const space = h.spaces.find(each => each.name === 'api:STA-1')!;
	expect(space.railStatus?.pipeline).toBe('passing');
	expect(space.repo).toBe('api');
	expect(space.key).toBe('STA-1');
});

test('a refresh that changes nothing hands back the same spaces', async () => {
	const h = setup(twoRepos());
	await h.settle();
	const before = h.spaces;
	await h.settle();
	expect(h.spaces).toBe(before);
	for (const [index, space] of h.spaces.entries())
		expect(space).toBe(before[index]!);
});

test('a space closed in one repo leaves the list, and the other repo’s stay', async () => {
	const repos = twoRepos();
	const h = setup(repos);
	await h.settle();
	repos[1]!.keys = ['STA-9'];
	await h.settle();
	expect(h.spaces.map(space => space.name)).toEqual([
		'@work:main',
		'api:main',
		'api:STA-9',
		'web:main',
		'web:STA-1',
	]);
});

test('the rail is told it is loaded once every repo has listed its spaces', async () => {
	const h = setup(twoRepos());
	expect(h.loaded).toBe(0);
	await h.settle();
	expect(h.loaded).toBeGreaterThan(0);
});

test('a ticket space carries the repos it holds and all of their tags', async () => {
	const tickets: Record<string, string[]> = {'@work:B2B-5': ['web', 'api']};
	const h = setup(
		[
			repo('@work', ['B2B-5'], {isWorkdir: true, tag: ''}),
			repo('api', ['STA-1']),
			repo('web', []),
		],
		{},
		tickets,
	);
	await h.settle();
	const ticket = h.spaces.find(each => each.name === '@work:B2B-5')!;
	expect(ticket.repo).toBe('@work');
	expect(ticket.key).toBe('B2B-5');
	// In the ticket's own order, which is the order its repos were added.
	expect(ticket.ticketRepos).toEqual([
		{name: 'web', tag: 'we'},
		{name: 'api', tag: 'ap'},
	]);
	expect(ticket.repoTag).toBe('we+ap');
	// The work dir's main space is no ticket, and a repo's space has one tag.
	expect(h.spaces[0]?.ticketRepos).toBeUndefined();
	expect(
		h.spaces.find(each => each.name === 'api:STA-1')?.ticketRepos,
	).toBeUndefined();

	// A repo added since shows at the next listing, though nothing else changed.
	tickets['@work:B2B-5'] = ['web', 'api'];
	await h.settle();
	expect(h.spaces.find(each => each.name === '@work:B2B-5')).toBe(ticket);
	const web = h.spaces.find(each => each.repo === 'web');
	tickets['@work:B2B-5'] = ['web'];
	await h.settle();
	const shrunk = h.spaces.find(each => each.name === '@work:B2B-5')!;
	expect(shrunk.repoTag).toBe('we');
	expect(shrunk.ticketRepos).toEqual([{name: 'web', tag: 'we'}]);
	// The other repos' spaces are the objects they were.
	expect(h.spaces.find(each => each.repo === 'web')).toBe(web);
});
