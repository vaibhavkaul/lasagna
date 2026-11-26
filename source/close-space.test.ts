import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {workdirFixture} from '../test/helpers/workdir-fixture.ts';
import {
	readConfig,
	repoRootsAt,
	setDefaultRepo,
	type PappardelleConfig,
} from './config.ts';
import type {TrackerIssue} from './providers/types.ts';
import {repoContext, resetRepoContexts} from './repo-context.ts';
import {
	closeHooksDepsFor,
	defaultCloseHooksDeps,
	resolveDeinitCommands,
	runCloseHooks,
	runTicketCloseHooks,
	shouldAttach,
	type CloseHooksDeps,
} from './close-space.ts';

const config: PappardelleConfig = {
	version: 1,
	pre_workspace_deinit: [{name: 'global', run: 'echo global'}],
	profiles: {
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['The Hive'],
			pre_workspace_deinit: [{name: 'hive', run: 'echo hive'}],
		},
		jams: {
			display_name: 'Stardust Jams',
			keywords: ['music'],
			pre_workspace_deinit: [{name: 'jams', run: 'echo jams'}],
		},
	},
};

function issue(fields: Partial<TrackerIssue>): TrackerIssue {
	return {
		identifier: 'STA-1',
		title: '',
		state: {name: 'Todo', type: 'unstarted', color: '#fff'},
		...fields,
	};
}

const names = (commands: Array<{name: string}>) =>
	commands.map(command => command.name);

test('a project match picks its profile over a title keyword match', () => {
	const commands = resolveDeinitCommands(
		config,
		issue({title: 'music player', project: {name: 'The Hive'}}),
	);
	expect(names(commands)).toStrictEqual(['global', 'hive']);
});

test('the title picks the profile when no project matches', () => {
	const commands = resolveDeinitCommands(
		config,
		issue({title: 'music player', project: {name: 'Elsewhere'}}),
	);
	expect(names(commands)).toStrictEqual(['global', 'jams']);
});

test('without an issue only the global hooks run', () => {
	expect(names(resolveDeinitCommands(config, null))).toStrictEqual(['global']);
});

test('runCloseHooks passes the space key and repo context to the hooks', async () => {
	const calls: unknown[] = [];
	const result = await runCloseHooks(
		{name: 'STA-1', worktreePath: '/wt/STA-1', trackerIssue: null},
		{
			readConfig: () => ({kind: 'valid', config}),
			async runDeinit(commands, worktreePath, context) {
				calls.push({commands: names(commands), worktreePath, context});
				return {success: false, failedCommand: 'global'};
			},
			context: () => ({
				repoRoot: '/repo',
				mainRepoRoot: '/repo',
				repoName: 'r',
			}),
		},
	);
	expect(result).toStrictEqual({kind: 'failed', failedCommand: 'global'});
	expect(calls).toStrictEqual([
		{
			commands: ['global'],
			worktreePath: '/wt/STA-1',
			context: {
				issueKey: 'STA-1',
				repoRoot: '/repo',
				mainRepoRoot: '/repo',
				repoName: 'r',
			},
		},
	]);
});

test('an invalid config skips the deinit commands and says why', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-close-'));
	teardown(() => {
		fs.rmSync(dir, {recursive: true, force: true});
	});
	const marker = path.join(dir, 'deinit-ran');
	fs.writeFileSync(
		path.join(dir, '.pappardelle.yml'),
		`version: 1
profiles: {}
pre_workspace_deinit:
  - name: mark
    run: touch ${marker}
agent_profiles:
  opus:
    command: claude
    model: 7
`,
	);
	const result = await runCloseHooks(
		{name: 'STA-1', worktreePath: dir, trackerIssue: null},
		{
			...defaultCloseHooksDeps,
			readConfig: () =>
				readConfig({homeConfigDir: path.join(dir, 'home'), projectDir: dir}),
		},
	);
	expect(result.kind).toBe('config-invalid');
	expect(
		result.kind === 'config-invalid' &&
			result.errors.some(error => error.includes('agent_profiles.opus.model')),
	).toBe(true);
	expect(fs.existsSync(marker)).toBe(false);
});

test("a repo's .envrc reaches its deinit commands, in their environment and in their templates", async () => {
	teardown(resetRepoContexts);
	teardown(() => {
		setDefaultRepo(undefined);
	});
	const {repos} = workdirFixture({
		repos: {
			api: {
				'.envrc': 'export DEINIT_TOKEN=from-envrc\n',
				'.pappardelle.yml': [
					'version: 1',
					'profiles:',
					'  t:',
					'    display_name: T',
					'pre_workspace_deinit:',
					'  - name: note',
					// The first is read by bash, the second filled in before it runs.
					// eslint-disable-next-line no-template-curly-in-string -- a hook template
					'    run: printf "%s %s" "$DEINIT_TOKEN" "${DEINIT_TOKEN}" > deinit-saw',
					'',
				].join('\n'),
			},
		},
	});
	const {root} = repos['api']!;
	expect(process.env['DEINIT_TOKEN']).toBeUndefined();
	setDefaultRepo(repoRootsAt(root));
	const result = await runCloseHooks({
		name: 'STA-1',
		worktreePath: root,
		trackerIssue: null,
	});
	expect(result).toStrictEqual({kind: 'ran'});
	expect(fs.readFileSync(path.join(root, 'deinit-saw'), 'utf8')).toBe(
		'from-envrc from-envrc',
	);
});

test("on a rail of several repos, a space's deinit commands run with its own repo's .envrc", async () => {
	teardown(resetRepoContexts);
	const hook = (repo: string) =>
		[
			'version: 1',
			'profiles:',
			'  t:',
			'    display_name: T',
			'pre_workspace_deinit:',
			'  - name: note',
			`    run: printf "%s %s" "$DEINIT_TOKEN" "\${DEINIT_TOKEN}" > deinit-saw-${repo}`,
			'',
		].join('\n');
	const {repos} = workdirFixture({
		repos: {
			api: {
				'.envrc': 'export DEINIT_TOKEN=token-of-api\n',
				'.pappardelle.yml': hook('api'),
			},
			web: {
				'.envrc': 'export DEINIT_TOKEN=token-of-web\n',
				'.pappardelle.yml': hook('web'),
			},
		},
	});
	for (const label of ['api', 'web']) {
		const {root} = repos[label]!;
		const result = await runCloseHooks(
			{name: 'STA-1', worktreePath: root, trackerIssue: null},
			closeHooksDepsFor(repoContext(root)),
		);
		expect(result).toStrictEqual({kind: 'ran'});
		expect(
			fs.readFileSync(path.join(root, `deinit-saw-${label}`), 'utf8'),
		).toBe(`token-of-${label} token-of-${label}`);
	}
});

test('a row the registry no longer lists is not attached', () => {
	expect(shouldAttach({name: 'STA-1'}, ['STA-2'])).toBe(false);
});

test('registered, main, and pending rows attach, as does an unreadable registry', () => {
	expect(shouldAttach({name: 'STA-1'}, ['STA-1'])).toBe(true);
	expect(shouldAttach({name: 'main', isMainWorktree: true}, [])).toBe(true);
	expect(shouldAttach({name: 'STA-3', isPending: true}, [])).toBe(true);
	expect(shouldAttach({name: 'STA-1'}, null)).toBe(true);
});

/** A repo of a ticket whose one deinit command succeeds, fails, or whose config is invalid. */
function ticketRepo(name: string, outcome: 'ok' | 'fails' | 'invalid') {
	return {
		repo: {
			name,
			root: `/work/${name}`,
			mainRoot: `/work/${name}`,
			readConfig: () => readConfig(),
		},
		worktreePath: `/tickets/B2B-5/${name}`,
		outcome,
	};
}

function ticketHooks(members: Array<ReturnType<typeof ticketRepo>>) {
	const ran: string[] = [];
	const depsFor = (repo: {name: string}): CloseHooksDeps => {
		const {outcome} = members.find(member => member.repo.name === repo.name)!;
		return {
			readConfig: () =>
				outcome === 'invalid'
					? {kind: 'invalid', errors: ['profiles: required object field']}
					: {
							kind: 'valid',
							config: {
								version: 1,
								profiles: {},
								pre_workspace_deinit: [
									{name: `stop ${repo.name}`, run: 'true'},
								],
							},
						},
			async runDeinit(commands, worktreePath, context) {
				ran.push(
					`${context.repoName} ${context.issueKey} ${worktreePath} ${names(commands as Array<{name: string}>).join(',')}`,
				);
				return outcome === 'fails'
					? {success: false, failedCommand: commands[0]!.name}
					: {success: true};
			},
			context: () => ({
				repoRoot: `/work/${repo.name}`,
				mainRepoRoot: `/work/${repo.name}`,
				repoName: repo.name,
			}),
		};
	};

	return {
		ran,
		run: async () =>
			runTicketCloseHooks(
				{name: 'B2B-5', trackerIssue: null},
				members,
				depsFor as Parameters<typeof runTicketCloseHooks>[2],
			),
	};
}

test("a ticket space's close runs each repo's own hooks, in that repo's worktree", async () => {
	const hooks = ticketHooks([ticketRepo('api', 'ok'), ticketRepo('web', 'ok')]);
	expect(await hooks.run()).toStrictEqual({kind: 'ran'});
	expect(hooks.ran).toStrictEqual([
		'api B2B-5 /tickets/B2B-5/api stop api',
		'web B2B-5 /tickets/B2B-5/web stop web',
	]);
});

test("a repo's hook that fails stops the close, naming the repo, before the repos after it", async () => {
	const hooks = ticketHooks([
		ticketRepo('api', 'ok'),
		ticketRepo('web', 'fails'),
		ticketRepo('data', 'ok'),
	]);
	expect(await hooks.run()).toStrictEqual({
		kind: 'failed',
		failedCommand: 'web: stop web',
	});
	expect(hooks.ran).toHaveLength(2);
});

test('a repo whose config is invalid is skipped and reported, and the others still run', async () => {
	const hooks = ticketHooks([
		ticketRepo('api', 'invalid'),
		ticketRepo('web', 'ok'),
	]);
	expect(await hooks.run()).toStrictEqual({
		kind: 'config-invalid',
		errors: ['api: profiles: required object field'],
	});
	expect(hooks.ran).toStrictEqual(['web B2B-5 /tickets/B2B-5/web stop web']);
});
