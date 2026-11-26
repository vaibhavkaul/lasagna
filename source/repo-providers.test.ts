import {test, expect, beforeEach} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {workdirFixture} from '../test/helpers/workdir-fixture.ts';
import {
	createIssueTracker,
	createVcsHost,
	issueTrackerFor,
	resetProviders,
	setOwnRepo,
	setRepoProviderSources,
	vcsHostFor,
} from './providers/index.ts';
import {clearRecentErrors, getRecentErrors} from './logger.ts';
import {bootstrapRepo} from './repo-bootstrap.ts';
import {repoContext, resetRepoContexts} from './repo-context.ts';
import {setSpaceScopes} from './space-scope.ts';
import {formatSpaceRef, parseSpaceRef} from './space-ref.ts';
import {getIssue, getIssueCached, getIssues} from './tracker.ts';

const PROFILES = 'profiles:\n  t:\n    display_name: T\n';

// The providers are kept per process, like the singletons they replace.
beforeEach(() => {
	resetProviders();
	resetRepoContexts();
});

/** A `linctl` that answers every issue with its token and directory as the title. */
function fakeLinctl(): void {
	const bin = tempDir('lasagna-bin-');
	fs.writeFileSync(
		path.join(bin, 'linctl'),
		'#!/bin/sh\nprintf \'{"identifier":"%s","title":"%s in %s","state":{"name":"Todo","type":"unstarted","color":"#fff"}}\\n\' "$3" "$TRACKER_TOKEN" "$(basename "$PWD")"\n',
		{mode: 0o755},
	);
	const previous = process.env['PATH'];
	process.env['PATH'] = `${bin}${path.delimiter}${previous ?? ''}`;
	teardown(() => {
		process.env['PATH'] = previous;
	});
}

function twoRepos() {
	return workdirFixture({
		repos: {
			api: {
				'.pappardelle.yml': `version: 1\nissue_tracker:\n  provider: beads\nvcs_host:\n  provider: gitlab\n  host: gitlab.example.com\n${PROFILES}`,
			},
			web: {
				'.pappardelle.yml': `version: 1\nissue_tracker:\n  provider: jira\n  base_url: https://example.atlassian.net\n${PROFILES}`,
			},
		},
	});
}

test('each repo gets the tracker and VCS host its own config names', () => {
	const {repos} = twoRepos();
	const api = bootstrapRepo(repoContext(repos['api']!.root));
	const web = bootstrapRepo(repoContext(repos['web']!.root));
	expect(api.repoName).toBe(repos['api']!.name);
	expect(issueTrackerFor(api.repoName).name).toBe('beads');
	expect(issueTrackerFor(web.repoName).name).toBe('jira');
	expect(vcsHostFor(api.repoName).name).toBe('gitlab');
	expect(vcsHostFor(web.repoName).name).toBe('github');
});

test('a repo whose tracker and VCS host cannot be built is named once and gets the defaults', async () => {
	const {repos} = workdirFixture({
		repos: {
			// A Jira tracker needs its base_url, and nobody knows this host.
			bad: {
				'.pappardelle.yml': `version: 1\nissue_tracker:\n  provider: jira\nvcs_host:\n  provider: bitbucket\n${PROFILES}`,
			},
			web: {
				'.pappardelle.yml': `version: 1\nissue_tracker:\n  provider: jira\n  base_url: https://example.atlassian.net\n${PROFILES}`,
			},
		},
	});
	clearRecentErrors();
	teardown(clearRecentErrors);
	const bad = bootstrapRepo(repoContext(repos['bad']!.root)).repoName;
	const web = bootstrapRepo(repoContext(repos['web']!.root)).repoName;
	// A rail asks on every refresh, from inside a state update.
	const tracker = issueTrackerFor(bad);
	expect(tracker.name).toBe('linear');
	expect(issueTrackerFor(bad)).toBe(tracker);
	expect(tracker.getIssueCached('STA-1')).toBeNull();
	const host = vcsHostFor(bad);
	expect(host.name).toBe('github');
	expect(vcsHostFor(bad)).toBe(host);
	// The other repo is untouched.
	expect(issueTrackerFor(web).name).toBe('jira');
	const errors = getRecentErrors().map(entry => entry.message);
	expect(errors).toEqual([
		`The issue tracker of ${bad} could not be set up; using the default: issue_tracker.base_url is required when provider is "jira"`,
		`The VCS host of ${bad} could not be set up; using the default: Unknown VCS host provider: "bitbucket"`,
	]);
});

test("a repo's providers are built once", () => {
	const {repos} = twoRepos();
	const {repoName} = bootstrapRepo(repoContext(repos['api']!.root));
	expect(issueTrackerFor(repoName)).toBe(issueTrackerFor(repoName));
	expect(vcsHostFor(repoName)).toBe(vcsHostFor(repoName));
});

test('bootstrapping a repo again hands back the same stores', () => {
	const {repos} = twoRepos();
	const first = bootstrapRepo(repoContext(repos['api']!.root));
	const second = bootstrapRepo(repoContext(repos['api']!.root));
	expect(second.daos).toBe(first.daos);
});

test("another repo's providers leave the process's own alone", () => {
	const {repos} = twoRepos();
	const own = createIssueTracker();
	const ownVcs = createVcsHost();
	const {repoName} = bootstrapRepo(repoContext(repos['api']!.root));
	expect(issueTrackerFor(repoName)).not.toBe(own);
	expect(createIssueTracker()).toBe(own);
	expect(createIssueTracker().name).toBe('linear');
	expect(createVcsHost()).toBe(ownVcs);
});

test("the process's own repo answers by name with its own providers", () => {
	const own = createIssueTracker({provider: 'beads'});
	setOwnRepo('own-repo');
	expect(issueTrackerFor('own-repo')).toBe(own);
	expect(vcsHostFor('own-repo')).toBe(createVcsHost());
});

test("each repo's tracker runs in that repo, with that repo's .envrc", async () => {
	fakeLinctl();
	const {repos} = workdirFixture({
		repos: {
			api: {
				'.pappardelle.yml': `version: 1\n${PROFILES}`,
				'.envrc': 'export TRACKER_TOKEN=token-of-api\n',
			},
			web: {
				'.pappardelle.yml': `version: 1\n${PROFILES}`,
				'.envrc': 'export TRACKER_TOKEN=token-of-web\n',
			},
		},
	});
	const api = bootstrapRepo(repoContext(repos['api']!.root)).repoName;
	const web = bootstrapRepo(repoContext(repos['web']!.root)).repoName;
	const [fromApi, fromWeb] = await Promise.all([
		issueTrackerFor(api).getIssue('STA-1'),
		issueTrackerFor(web).getIssue('STA-1'),
	]);
	expect(fromApi?.title).toBe(`token-of-api in ${api}`);
	expect(fromWeb?.title).toBe(`token-of-web in ${web}`);
	expect(process.env['TRACKER_TOKEN']).toBeUndefined();
});

test('issues asked for by space name come from each space\u2019s own tracker', async () => {
	fakeLinctl();
	const {repos} = workdirFixture({
		repos: {
			api: {
				'.pappardelle.yml': `version: 1\n${PROFILES}`,
				'.envrc': 'export TRACKER_TOKEN=token-of-api\n',
			},
			web: {
				'.pappardelle.yml': `version: 1\n${PROFILES}`,
				'.envrc': 'export TRACKER_TOKEN=token-of-web\n',
			},
		},
	});
	const contexts = new Map(
		Object.values(repos).map(repo => [repo.name, repoContext(repo.root)]),
	);
	const stores = new Map(
		[...contexts].map(([name, context]) => [name, bootstrapRepo(context)]),
	);
	setSpaceScopes(name => {
		const ref = parseSpaceRef(name);
		const repo = ref.repo === undefined ? undefined : contexts.get(ref.repo);
		return repo && {repo, key: ref.key};
	});
	teardown(() => setSpaceScopes(undefined));
	const api = repos['api']!.name;
	const web = repos['web']!.name;
	// The same key in two repos is two issues.
	const names = [formatSpaceRef(api, 'STA-1'), formatSpaceRef(web, 'STA-1')];
	// One at a time goes through each repo's CLI; the bulk read then answers
	// from what each tracker has cached.
	const fromApi = await getIssue(names[0]!);
	const fromWeb = await getIssue(names[1]!);
	expect(fromApi?.title).toBe(`token-of-api in ${api}`);
	expect(fromWeb?.title).toBe(`token-of-web in ${web}`);
	const issues = await getIssues(names);
	expect(issues.get(names[0]!)?.title).toBe(`token-of-api in ${api}`);
	expect(issues.get(names[1]!)?.title).toBe(`token-of-web in ${web}`);
	expect(getIssueCached(names[1]!)?.title).toBe(`token-of-web in ${web}`);
	// Each title is stored with its own repo, under the space's own key.
	expect(stores.get(api)!.daos.spaceState.read('STA-1')?.issueTitle).toBe(
		`token-of-api in ${api}`,
	);
	expect(stores.get(web)!.daos.spaceState.read('STA-1')?.issueTitle).toBe(
		`token-of-web in ${web}`,
	);
});

test('a repo handed no config gets the default providers', () => {
	setRepoProviderSources('bare', {});
	expect(issueTrackerFor('bare').name).toBe('linear');
	expect(vcsHostFor('bare').name).toBe('github');
});
