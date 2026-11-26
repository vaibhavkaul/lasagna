// The real App on a work dir: two repos and the work dir's own main space on
// one rail. Run through verify-workdir-rail.ts, which gives it a throwaway
// HOME.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import React from 'react';
import {render} from '../test/helpers/opentui-render.ts';
import App from '../source/app.tsx';
import {setDefaultRepo, workdirRepoRoots} from '../source/config.ts';
import {
	createIssueTracker,
	issueTrackerFor,
	resetProviders,
	setOwnRepo,
	setRepoProviderSources,
	vcsHostFor,
} from '../source/providers/index.ts';
import type {TrackerIssue} from '../source/providers/types.ts';
import {getRegistryPathForRepo} from '../source/space-registry.ts';
import {setSpaceScopes} from '../source/space-scope.ts';
import {createStateDaos} from '../source/state-daos.ts';
import {startWorkdir} from '../source/workdir-runtime.ts';
import {StatusHarness, until} from './program-status-harness.ts';

const harness = new StatusHarness();
const originalDirectory = process.cwd();
const frames: Array<{scenario: string; frame: string}> = [];
let view: Awaited<ReturnType<typeof render>> | undefined;

const git = (cwd: string, ...args: string[]) =>
	execFileSync(
		'git',
		[
			'-C',
			cwd,
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@example.com',
			...args,
		],
		{stdio: 'pipe'},
	);

async function expectFrame(
	scenario: string,
	check: (lines: string[]) => boolean,
) {
	const frame = await until(
		() => view?.lastFrame() ?? '',
		current => check(current.split('\n')),
		scenario,
	);
	frames.push({scenario, frame});
	console.log(`PASS workdir rail: ${scenario}`);
	return frame.split('\n');
}

/** The rows of the rail, without their frames and padding. */
const rows = (lines: string[]) =>
	lines
		.filter(line => line.startsWith('│'))
		.map(line => line.slice(1, -1).trim())
		.filter(Boolean);

const has = (lines: string[], text: string) =>
	lines.some(line => line.includes(text));

try {
	// A work dir that is no checkout, holding two that are.
	const work = path.join(realpathSync(harness.root), 'work');
	const stateDir = path.join(harness.root, 'state');
	const repos = ['api-server', 'web-app'];
	const open: Record<string, string[]> = {
		'api-server': ['B2B-12', 'API-7'],
		'web-app': ['B2B-12'],
	};
	for (const name of repos) {
		mkdirSync(path.join(work, name), {recursive: true});
		git(path.join(work, name), 'init', '--quiet');
		git(path.join(work, name), 'commit', '--quiet', '--allow-empty', '-m', 'x');
		const registry = getRegistryPathForRepo(name, stateDir);
		mkdirSync(path.dirname(registry), {recursive: true});
		writeFileSync(registry, JSON.stringify(open[name]));
	}

	mkdirSync(path.join(work, '.lasagna'));
	writeFileSync(
		path.join(work, '.lasagna', 'workdir.yml'),
		[
			'version: 1',
			'default_profile: fixture',
			'profiles:',
			'  fixture:',
			'    display_name: Fixture',
			'    keywords: []',
			'repos:',
			'  api-server:',
			'    team_prefix: API',
			'  web-app:',
			'    team_prefix: WEB',
			// Listed, but gone: it is left off the rail.
			'  removed-repo:',
			'',
		].join('\n'),
	);

	// What cli.tsx does for a TUI started at a work dir's root.
	const workRoots = workdirRepoRoots(work);
	setDefaultRepo(workRoots);
	process.chdir(work);
	const daosFor = (repo: string, mainRoot: string) =>
		createStateDaos({
			repo,
			stateDir,
			sqlite: harness.sqlite,
			mainRoot: () => mainRoot,
		});
	const issue = (repo: string, key: string): TrackerIssue => ({
		identifier: key,
		title: `${key} in ${repo}`,
		state: {name: 'In Progress', type: 'started', color: 'blue'},
	});
	// A tracker per repo, answering from memory: the same key is a different
	// issue in each.
	const stubTracker = (repo: string) => {
		const tracker = issueTrackerFor(repo);
		tracker.getIssue = async key => issue(repo, key);
		tracker.getIssueCached = key => issue(repo, key);
		tracker.getIssues = async keys =>
			new Map(keys.map(key => [key, issue(repo, key)]));
		vcsHostFor(repo).getBulkRailStatus = async () => new Map();
	};

	createIssueTracker({provider: 'beads'});
	setOwnRepo(workRoots.name);
	const workdir = startWorkdir(
		work,
		{repoName: workRoots.name, daos: daosFor(workRoots.name, work)},
		{
			setup(repo) {
				setRepoProviderSources(repo.name, {
					trackerConfig: {provider: 'beads'},
					cwd: repo.mainRoot,
				});
				stubTracker(repo.name);
				return {daos: daosFor(repo.name, repo.mainRoot)};
			},
		},
	);
	stubTracker(workRoots.name);
	assert.deepEqual(
		workdir.repos.map(repo => repo.name),
		repos,
		'the rail has the repos whose directories exist',
	);

	view = await render(
		React.createElement(App, {
			daos: workdir.daos,
			workdir,
			paneLayout: null,
			commitSha: 'fixture',
			installedVersion: null,
		}),
		{width: 80, height: 40},
	);

	const byRepo = await expectFrame(
		'the root main space, the repos, and each repo over its spaces',
		lines =>
			lines[0]!.startsWith('╭─ 🍝 work ') &&
			has(lines, '▾ repos (2)') &&
			has(lines, 'api-server (2)') &&
			has(lines, 'web-app (1)') &&
			has(lines, 'B2B-12 in web-app'),
	);
	assert.match(
		byRepo[0]!,
		/ 2 repos ─╮$/,
		'the workspace box counts the repos',
	);
	assert.match(byRepo[2]!, /main/, 'the root main space leads the rail');
	assert.match(byRepo[3]!, /^╰─+╯$/, 'the workspace box holds it alone');
	assert.ok(
		byRepo.some(
			line => line.startsWith('╭─ rail') && line.endsWith(' 3 spaces ─╮'),
		),
		'the rail counts the spaces of every repo',
	);
	// Under each repo, its spaces newest first, by their own key and titled by
	// their own repo's tracker.
	const railRows = rows(byRepo).slice(1);
	assert.deepEqual(
		railRows.map(row => row.replace(/^\S+ /, '')),
		[
			'repos (2)',
			'api-server',
			'web-app',
			'(2)',
			'as B2B-12 B2B-12 in api-server',
			'as API-7 API-7 in api-server',
			'(1)',
			'wa B2B-12 B2B-12 in web-app',
		],
		"rows, with each row's leading word (its status icon or header name) cut",
	);
	assert.ok(
		!has(byRepo, 'removed-repo'),
		'a listed repo that is gone is left off',
	);
	assert.ok(!has(byRepo, 'api-server:'), 'rows show the key, not repo:KEY');

	await view.stdin.write('t');
	const byTicket = await expectFrame(
		't groups by ticket: one header over every repo that has the key',
		lines => has(lines, 'B2B-12 (2)') && has(lines, 'API-7 (1)'),
	);
	assert.ok(!has(byTicket, 'api-server (2)'), 'the repo headers are gone');
	const ticket = byTicket.findIndex(line => line.includes('B2B-12 (2)'));
	assert.match(byTicket[ticket + 1]!, /as B2B-12 B2B-12 in api-server/);
	assert.match(byTicket[ticket + 2]!, /wa B2B-12 B2B-12 in web-app/);
	assert.ok(has(byTicket, 'Grouped by ticket'), 'the header says what changed');

	await view.stdin.write('t');
	await expectFrame('t again groups by repo', lines =>
		has(lines, 'api-server (2)'),
	);

	await view.stdin.write('r');
	const folded = await expectFrame(
		"r folds the repos' main spaces under their header",
		lines => has(lines, '▸ repos (2)'),
	);
	assert.ok(
		!rows(folded).some(row => /^\S+ (api-server|web-app)$/.test(row)),
		'the main space rows are hidden',
	);
	assert.match(folded[2]!, /main/, 'the root main space stays');
	await view.stdin.write('r');
	await expectFrame('r again unfolds them', lines => has(lines, '▾ repos (2)'));

	await view.stdin.write('/');
	await view.stdin.write('web-app');
	const search = await expectFrame(
		"a search by repo name finds that repo's spaces",
		lines =>
			lines[0]!.endsWith(' 2 matches ─╮') && has(lines, 'B2B-12 in web-app'),
	);
	assert.ok(!has(search, 'in api-server'), 'and none of another repo');
	await view.stdin.write('\u001B');
	await expectFrame('escape restores the grouped rail', lines =>
		has(lines, 'api-server (2)'),
	);

	await view.stdin.write('n');
	const picker = await expectFrame(
		'n asks which repo the new space is made in',
		lines => has(lines, '+ New Session in') && has(lines, '1 api-server'),
	);
	assert.ok(has(picker, '2 web-app'), 'every repo is listed');
	await view.stdin.write('2');
	await expectFrame('picking a repo opens the new-space dialog for it', lines =>
		has(lines, '+ New Session in web-app'),
	);
	await view.stdin.write('\u001B');
	await expectFrame('escape closes the dialog', lines =>
		has(lines, 'api-server (2)'),
	);

	// Down to the first space of api-server: the root, two repo main spaces,
	// then it.
	await view.stdin.write('jjj');
	await view.stdin.write('x');
	await expectFrame(
		'x asks to close the selected space, named with its repo',
		lines => has(lines, 'Close space api-server:B2B-12?'),
	);
	await view.stdin.write('\u001B');
	await expectFrame('escape leaves it open', lines =>
		has(lines, 'as B2B-12 B2B-12 in api-server'),
	);

	// A space opened in one repo while the rail is up shows under that repo.
	await workdir.repo('web-app')!.daos.registry.add('WEB-30');
	await workdir.daos.highlight.request({
		issueKey: 'web-app:WEB-30',
		focus: false,
	});
	await expectFrame(
		'a space opened in a repo appears under that repo',
		lines => has(lines, 'web-app (2)') && has(lines, 'WEB-30 in web-app'),
		// The rail lists again every ten seconds.
	);

	writeFileSync(
		path.join(harness.root, 'workdir-rail.json'),
		JSON.stringify({frames}, null, 2),
	);
	console.log(
		`Workdir rail evidence ${harness.root}/workdir-rail.json (--keep preserves it)`,
	);
} catch (error) {
	console.error(view?.lastFrame());
	throw error;
} finally {
	view?.unmount();
	setSpaceScopes(undefined);
	setDefaultRepo(undefined);
	resetProviders();
	process.chdir(originalDirectory);
	await harness.cleanup();
}
