// A work dir of three real checkouts with what ticket-ops.ts runs on, for
// tests of ticket spaces. idow is stood in for by what it does to a repo (a
// worktree where it is told to make one); git, the stores and the files are
// real, under a home and a state dir of the test's own.
import fs from 'node:fs';
import path from 'node:path';
import {repoContext, workdirRepoContext} from '../../source/repo-context.ts';
import {
	newSpaceIdentity,
	worktreePathFor,
} from '../../source/space-identity.ts';
import {createStateDaos, type StateDaos} from '../../source/state-daos.ts';
import type {TicketEnv} from '../../source/ticket-ops.ts';
import {TicketStore} from '../../source/ticket-space.ts';
import {writeFiles} from './config-fixtures.ts';
import {testState} from './state.ts';
import {teardown} from './teardown.ts';
import {tempDir} from './temp-dir.ts';
import {git, workdirFixture} from './workdir-fixture.ts';

export const KEY = 'B2B-123';

export function ticketFixture(options: {failMove?: boolean} = {}) {
	const home = tempDir('lasagna-home-');
	const stateDir = tempDir('lasagna-state-');
	const marks = path.join(stateDir, 'deinit.log');
	const work = workdirFixture({
		repos: {
			api: {
				'CLAUDE.md': '# api rules\n',
				'src/api.ts': 'export const marker = "shared-marker";\n',
				'.claude/settings.json': JSON.stringify({
					permissions: {
						allow: ['Bash(./gradlew test:*)'],
						deny: ['Read(./.env)'],
					},
					hooks: {Stop: []},
				}),
				'.github/pull_request_template.md': '## What\n',
			},
			web: {
				'src/web.ts': 'export const marker = "shared-marker";\n',
				'.claude/settings.json': JSON.stringify({
					permissions: {allow: ['Bash(yarn lint)']},
					env: {TOKEN: 'x'},
				}),
			},
			data: {'models/a.sql': 'select 1\n'},
		},
		workdirConfig: names =>
			[
				'version: 1',
				'agent_profiles:',
				'  codex:',
				'    command: codex',
				'profiles:',
				'  t:',
				'    display_name: T',
				'    vars:',
				"      PR_TITLE_FORMAT: '[KEY] Summary'",
				'repos:',
				...Object.values(names).flatMap(name => [
					`  ${name}:`,
					'    pre_workspace_deinit:',
					`      - name: mark`,
					// eslint-disable-next-line no-template-curly-in-string -- a shell template
					`        run: 'echo "${name} \${ISSUE_KEY} $PWD" >> ${marks}'`,
				]),
				'',
			].join('\n'),
	});
	writeFiles(work.work, {
		'CLAUDE.md':
			'# Work dir\n\nNever push without asking. See [more](./docs/more.md).\n',
	});
	for (const repo of Object.values(work.repos)) {
		git(repo.root, 'add', '-A');
		git(repo.root, 'commit', '-q', '-m', 'files');
	}

	// api has an origin whose default branch is known, as a clone does.
	const api = work.repos['api']!;
	const branch = git(api.root, 'branch', '--show-current');
	git(api.root, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
	git(
		api.root,
		'symbolic-ref',
		'refs/remotes/origin/HEAD',
		`refs/remotes/origin/${branch}`,
	);

	const workdir = workdirRepoContext(work.work);
	const repos = Object.values(work.repos).map(repo => repoContext(repo.root));
	// The work dir's stores and each repo's, in the run's mode, in one state
	// dir as one HOME keeps them.
	const own = testState({
		repo: workdir.name,
		stateDir,
		home,
		mainRoot: () => work.work,
	});
	const stores = new Map<string, StateDaos>([[workdir.name, own.daos]]);
	const daos = (name: string) => {
		let built = stores.get(name);
		if (!built) {
			const mainRoot =
				repos.find(repo => repo.name === name)?.mainRoot ?? work.work;
			const made = createStateDaos({
				repo: name,
				stateDir,
				sqlite: own.sqlite,
				home,
				mainRoot: () => mainRoot,
			});
			teardown(() => made.disconnectStatusDaemon());
			built = made;
			stores.set(name, built);
		}

		return built;
	};

	const steps: string[] = [];
	const idow: Array<{repo: string; args: string[]}> = [];
	const told: Array<{key: string; text: string}> = [];
	/** What the agents of plain spaces were told, by `repo:KEY`. */
	const toldSpaces: Array<{space: string; text: string}> = [];
	const env: TicketEnv = {
		home,
		workdir,
		repos: () => repos,
		daos,
		tickets: new TicketStore(path.join(stateDir, 'tickets')),
		async runIdow(args, repo) {
			idow.push({repo: repo.name, args});
			const at = args.indexOf('--worktree-only');
			const key = args.at(-1)!;
			if (at === -1) {
				steps.push(`lead ${key}`);
				// idow records the space, with the folder for its worktree, and
				// the title it read from the tracker.
				await daos(workdir.name).spaceIdentities.record(
					newSpaceIdentity({
						repo: workdir.name,
						key,
						worktreePath: worktreePathFor(home, workdir.name, key),
						socket: 'ticket-test',
					}),
				);
				await daos(workdir.name).spaceState.write(key, {
					issueTitle: 'Biz remittance credit',
				});
			} else {
				steps.push(`worktree ${repo.name}`);
				git(repo.root, 'worktree', 'add', '-q', '-b', key, args[at + 1]!);
			}

			return {code: 0, stdout: '', stderr: ''};
		},
		async git(cwd, args) {
			if (options.failMove && args[0] === 'worktree' && args[1] === 'move')
				throw new Error(
					'fatal: working trees containing submodules cannot be moved',
				);
			if (args[0] === 'worktree' && args[1] === 'move')
				steps.push(`move ${path.basename(path.dirname(args[2]!))}`);
			return git(cwd, ...args);
		},
		async tellLead(key, text) {
			told.push({key, text});
			return 'sent';
		},
		async tellSpace(repo, key, text) {
			steps.push(`tell ${repo}:${key}`);
			toldSpaces.push({space: `${repo}:${key}`, text});
			return 'sent';
		},
		async endSessions(repo, key) {
			steps.push(`end ${repo}:${key}`);
			return true;
		},
		showCompanions(ticket) {
			steps.push(`companions ${ticket.repos.map(repo => repo.name).join(',')}`);
		},
		lastTurns: async (_worktree, key) =>
			`${key}: 1 turns, last 1\n\nuser: expose the table\n  assistant: staged it`,
	};
	const {
		api: apiRepo,
		web,
		data,
	} = work.repos as Record<
		'api' | 'web' | 'data',
		{name: string; root: string}
	>;
	/** A plain space of a repo, as idow leaves one: a worktree, registered. */
	const plainSpace = async (
		repo: {name: string; root: string},
		title: string,
	) => {
		const worktree = worktreePathFor(home, repo.name, KEY);
		git(repo.root, 'worktree', 'add', '-q', '-b', KEY, worktree);
		await daos(repo.name).spaceIdentities.record(
			newSpaceIdentity({
				repo: repo.name,
				key: KEY,
				worktreePath: worktree,
				socket: 'ticket-test',
			}),
		);
		await daos(repo.name).registry.add(KEY);
		await daos(repo.name).spaceState.write(KEY, {issueTitle: title});
		return worktree;
	};

	const folder = path.join(
		home,
		'.lasagna',
		'worktrees',
		'_tickets',
		workdir.name.slice(1),
		KEY,
	);
	const read = (file: string) =>
		fs.readFileSync(path.join(folder, file), 'utf8');
	return {
		work,
		home,
		env,
		daos,
		steps,
		idow,
		told,
		toldSpaces,
		marks,
		api: apiRepo,
		web,
		data,
		folder,
		read,
		plainSpace,
		own: () => daos(workdir.name),
	};
}

export const worktreesOf = (root: string) =>
	git(root, 'worktree', 'list', '--porcelain')
		.split('\n')
		.filter(line => line.startsWith('worktree '))
		.map(line => line.slice('worktree '.length));
