// `lasagna space add-repo`, over the same real checkouts ticket-ops.ts is
// tested on: which space and repo the arguments name, and what it prints.
import {test, expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {KEY, ticketFixture} from '../test/helpers/ticket-fixture.ts';
import {git} from '../test/helpers/workdir-fixture.ts';
import {
	ADD_REPO_DETACHED,
	ADD_REPO_USAGE,
	commandWorkdir,
	runAddRepoCommand,
} from './ticket-command.ts';
import {createTicketSpace} from './ticket-ops.ts';

function command(env: NodeJS.ProcessEnv = {}, cwd?: string) {
	const t = ticketFixture();
	const out: string[] = [];
	const err: string[] = [];
	const detached: string[][] = [];
	const roots: string[] = [];
	const run = async (...argv: string[]) =>
		runAddRepoCommand(argv, {
			cwd: cwd ?? t.work.work,
			// Nothing of the developer's own space reaches the command.
			env: {HOME: t.home, ...env},
			ticketEnv(root) {
				roots.push(root);
				return t.env;
			},
			detach: argv => detached.push(argv),
			out: text => out.push(text),
			err: text => err.push(text),
		});
	return {...t, run, out, err, detached, roots};
}

test('add-repo adds a repo to a ticket space and says where its worktree is', async () => {
	const c = command();
	await createTicketSpace(c.env, {key: KEY, repos: [c.api.name, c.web.name]});
	expect(await c.run(KEY, c.data.name)).toBe(0);
	expect(c.err).toEqual([]);
	expect(c.out).toEqual([
		`Added ${c.data.name} to ${KEY}: ${path.join(c.folder, c.data.name)}`,
	]);
	expect(c.roots).toEqual([c.work.work]);
	expect(
		git(path.join(c.folder, c.data.name), 'branch', '--show-current'),
	).toBe(KEY);
	expect(c.told).toHaveLength(1);
	// The ticket space named as the work dir's own is the same space.
	const named = command();
	await createTicketSpace(named.env, {
		key: KEY,
		repos: [named.api.name, named.web.name],
	});
	expect(
		await named.run(`${named.work.workRepo}:${KEY}`, named.data.name),
	).toBe(0);
	expect(named.env.tickets.read(KEY)?.repos).toHaveLength(3);
});

test('add-repo to a plain space makes it a ticket space, named by its repo when asked', async () => {
	const c = command();
	const plain = await c.plainSpace(c.api, 'Biz remittance credit');
	expect(await c.run(`${c.api.name}:${KEY}`, c.web.name)).toBe(0);
	expect(c.out).toEqual([
		`${KEY} is now a ticket space in ${c.api.name} and ${c.web.name}. Its lead agent runs in ${c.folder}`,
	]);
	expect(fs.existsSync(plain)).toBe(false);
	expect(fs.existsSync(path.join(c.folder, c.api.name, '.git'))).toBe(true);
	expect(c.detached).toEqual([]);
});

test('what went wrong along the way is printed as a warning', async () => {
	const t = ticketFixture({failMove: true});
	const plain = await t.plainSpace(t.api, 'Biz remittance credit');
	const out: string[] = [];
	const status = await runAddRepoCommand([KEY, t.web.name], {
		cwd: t.work.work,
		env: {},
		ticketEnv: () => t.env,
		detach() {},
		out: text => out.push(text),
		err() {},
	});
	expect(status).toBe(0);
	expect(out[0]!.split('\n')[1]).toBe(
		`Warning: ${t.api.name}'s worktree stays at ${plain}: git worktree move failed (fatal: working trees containing submodules cannot be moved)`,
	);
});

test('without a space, it is the one the command runs in', async () => {
	// Not in any space: the key has to be given.
	const outside = command();
	expect(await outside.run(outside.web.name)).toBe(2);
	expect(outside.err).toEqual([
		`Not in a Lasagna space; name the space. ${ADD_REPO_USAGE}`,
	]);
	// A ticket space's own session: its repo is the work dir's pseudo-repo.
	const lead = command({
		LASAGNA_SPACE: KEY,
		LASAGNA_REPO: '@work',
	});
	await createTicketSpace(lead.env, {
		key: KEY,
		repos: [lead.api.name, lead.web.name],
	});
	expect(await lead.run(lead.data.name)).toBe(0);
	expect(lead.out[0]).toStartWith(`Added ${lead.data.name} to ${KEY}`);
	expect(lead.detached).toEqual([]);
});

test('converting the plain space the command runs in carries on in a process of its own', async () => {
	const own = ticketFixture();
	const session = {LASAGNA_SPACE: KEY, LASAGNA_REPO: own.api.name};
	const plain = await own.plainSpace(own.api, 'Biz remittance credit');
	const out: string[] = [];
	const detached: string[][] = [];
	const deps = (env: NodeJS.ProcessEnv) => ({
		cwd: plain,
		env,
		ticketEnv: () => own.env,
		detach: (argv: string[]) => detached.push(argv),
		out: (text: string) => out.push(text),
		err() {},
	});
	// Its own session is one of those that end, so nothing is done in it.
	expect(await runAddRepoCommand([own.web.name], deps(session))).toBe(0);
	expect(detached).toEqual([[`${own.api.name}:${KEY}`, own.web.name]]);
	expect(out[0]).toContain('in the background');
	expect(fs.existsSync(plain)).toBe(true);
	expect(own.idow).toEqual([]);

	// The detached run is the one that does it.
	out.length = 0;
	expect(
		await runAddRepoCommand(
			detached[0]!,
			deps({...session, [ADD_REPO_DETACHED]: '1'}),
		),
	).toBe(0);
	expect(detached).toHaveLength(1);
	expect(out[0]).toStartWith(`${KEY} is now a ticket space`);
	expect(fs.existsSync(plain)).toBe(false);
});

test('a space that cannot take the repo fails with the reason, and bad arguments with the usage', async () => {
	const c = command();
	expect(await c.run(KEY, 'nope')).toBe(1);
	expect(c.err.at(-1)).toStartWith('No repo nope in this work dir.');
	expect(await c.run(KEY, c.web.name)).toBe(1);
	expect(c.err.at(-1)).toBe(`No open space ${KEY} in this work dir`);
	for (const argv of [[], [KEY, c.web.name, 'extra'], [KEY, '--force']]) {
		expect(await c.run(...argv)).toBe(2);
		expect(c.err.at(-1)).toBe(ADD_REPO_USAGE);
	}

	expect(await c.run('--help')).toBe(0);
	expect(c.out.at(-1)).toContain('A plain space becomes a ticket space');
});

test('outside any work dir there is nothing to add a repo of', async () => {
	const c = command({}, '/');
	expect(await c.run(KEY, 'web')).toBe(2);
	expect(c.err[0]).toContain('this directory is in none');
	expect(c.roots).toEqual([]);
});

test('the work dir is found from its root, from a repo in it, and from a ticket space’s session', async () => {
	const t = ticketFixture();
	await createTicketSpace(t.env, {key: KEY, repos: [t.api.name, t.web.name]});
	expect(commandWorkdir(t.work.work, {})).toBe(t.work.work);
	expect(commandWorkdir(path.join(t.api.root, 'src'), {})).toBe(t.work.work);
	// A repo's worktree in a ticket folder is a checkout of that repo.
	expect(commandWorkdir(path.join(t.folder, t.api.name), {})).toBe(t.work.work);
	// The folder itself is outside the work dir: its session says whose it is.
	expect(commandWorkdir(t.folder, {})).toBeUndefined();
	expect(commandWorkdir(t.folder, {LASAGNA_MAIN_REPO_ROOT: t.work.work})).toBe(
		t.work.work,
	);
});
