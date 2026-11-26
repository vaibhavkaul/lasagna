import {test, expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {writeFiles} from '../test/helpers/config-fixtures.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	defaultIdentity,
	worktreePathFor,
	worktreesDir,
} from './space-identity.ts';
import {
	memberWorktree,
	ticketFolder,
	ticketFolderAt,
	ticketsDir,
	TicketStore,
	ticketStore,
	withTicketRepo,
	type Ticket,
} from './ticket-space.ts';

test('a ticket folder is ~/.lasagna/worktrees/_tickets/<workdir>/<KEY>, with a directory per repo', () => {
	expect(ticketsDir('/home/me')).toBe('/home/me/.lasagna/worktrees/_tickets');
	const folder = ticketFolder('/home/me', '@work', 'B2B-123');
	expect(folder).toBe('/home/me/.lasagna/worktrees/_tickets/work/B2B-123');
	expect(memberWorktree(folder, 'tts-business')).toBe(
		'/home/me/.lasagna/worktrees/_tickets/work/B2B-123/tts-business',
	);
	// The same key in another work dir is another ticket, in repos of its own.
	expect(ticketFolder('/home/me', '@other', 'B2B-123')).toBe(
		'/home/me/.lasagna/worktrees/_tickets/other/B2B-123',
	);
});

test("a work dir's own space has its ticket folder for a worktree, a repo's space its own", () => {
	expect(worktreePathFor('/home/me', '@work', 'B2B-123')).toBe(
		'/home/me/.lasagna/worktrees/_tickets/work/B2B-123',
	);
	expect(worktreesDir('/home/me', '@work')).toBe(
		'/home/me/.lasagna/worktrees/_tickets/work',
	);
	expect(worktreePathFor('/home/me', 'tts-business', 'B2B-123')).toBe(
		'/home/me/.lasagna/worktrees/tts-business/B2B-123',
	);
	// The stores name a ticket space's sessions and worktree as they do any
	// space's: its repo is the work dir's pseudo-repo.
	const identity = defaultIdentity(
		{
			repo: '@work',
			home: '/home/me',
			socket: 'lasagna_inner',
			mainRoot: () => '/code/work',
		},
		'B2B-123',
	);
	expect(identity.worktreePath).toBe(
		'/home/me/.lasagna/worktrees/_tickets/work/B2B-123',
	);
	expect(identity.tmux.agentSession).toBe('agent-@work-B2B-123');
});

const ticket: Ticket = {
	key: 'B2B-123',
	folder: '/home/me/.lasagna/worktrees/_tickets/work/B2B-123',
	repos: [
		{
			name: 'tts-business',
			worktreePath:
				'/home/me/.lasagna/worktrees/_tickets/work/B2B-123/tts-business',
		},
	],
};

test("a ticket's repos are kept under the work dir's pseudo-repo, a file per ticket", () => {
	const stateDir = tempDir('lasagna-tickets-');
	const store = ticketStore('@work', stateDir);
	expect(store.read('B2B-123')).toBeUndefined();
	expect(store.list()).toEqual([]);

	store.write(ticket);
	expect(store.file('B2B-123')).toBe(
		path.join(stateDir, 'repos', '@work', 'tickets', 'B2B-123.json'),
	);
	expect(store.read('B2B-123')).toEqual(ticket);

	const grown = withTicketRepo(ticket, {
		name: 'appian-server',
		worktreePath:
			'/home/me/.lasagna/worktrees/_tickets/work/B2B-123/appian-server',
	});
	store.write(grown);
	store.write({key: 'A-1', folder: '/f', repos: []});
	expect(store.read('B2B-123')?.repos.map(repo => repo.name)).toEqual([
		'tts-business',
		'appian-server',
	]);
	expect(store.list().map(each => each.key)).toEqual(['A-1', 'B2B-123']);
	// Nothing is left behind by a write.
	expect(fs.readdirSync(path.dirname(store.file('A-1'))).sort()).toEqual([
		'A-1.json',
		'B2B-123.json',
	]);

	store.remove('A-1');
	expect(store.read('A-1')).toBeUndefined();
	// Another work dir's tickets are its own.
	expect(ticketStore('@other', stateDir).read('B2B-123')).toBeUndefined();
});

test('a record that is not a ticket is no ticket, and unusable repos are left out', () => {
	const dir = tempDir('lasagna-tickets-');
	const store = new TicketStore(dir);
	writeFiles(dir, {
		'BAD-1.json': 'not json',
		'BAD-2.json': '[]',
		'BAD-3.json': '{"key": "BAD-3"}',
		'OK-1.json': JSON.stringify({
			key: 'OK-1',
			folder: '/f',
			repos: [{name: 'api', worktreePath: '/f/api'}, {name: 'web'}, 'x'],
		}),
		'notes.txt': 'not a record',
	});
	expect(store.read('BAD-1')).toBeUndefined();
	expect(store.read('BAD-2')).toBeUndefined();
	expect(store.read('BAD-3')).toBeUndefined();
	expect(store.read('OK-1')).toEqual({
		key: 'OK-1',
		folder: '/f',
		repos: [{name: 'api', worktreePath: '/f/api'}],
	});
	expect(store.list().map(each => each.key)).toEqual(['OK-1']);
});

test('adding a repo a ticket already has moves it instead', () => {
	const moved = withTicketRepo(ticket, {
		name: 'tts-business',
		worktreePath: '/elsewhere',
	});
	expect(moved.repos).toEqual([
		{name: 'tts-business', worktreePath: '/elsewhere'},
	]);
	expect(ticket.repos[0]!.worktreePath).not.toBe('/elsewhere');
});

test("a directory inside a ticket folder, or inside one of its repos, is in that ticket's folder", () => {
	const home = tempDir('lasagna-home-');
	const folder = ticketFolder(home, '@work', 'B2B-123');
	writeFiles(folder, {'tts-business/src/app.ts': '', 'CLAUDE.md': ''});
	const found = {key: 'B2B-123', folder, workdirRepo: '@work'};
	expect(ticketFolderAt(folder, home)).toEqual(found);
	expect(
		ticketFolderAt(path.join(folder, 'tts-business', 'src'), home),
	).toEqual(found);
	// A plain space's worktree, and a path that is not there, are in none.
	writeFiles(
		path.join(home, '.lasagna', 'worktrees', 'tts-business', 'B2B-9'),
		{x: ''},
	);
	expect(
		ticketFolderAt(
			path.join(home, '.lasagna', 'worktrees', 'tts-business', 'B2B-9'),
			home,
		),
	).toBeUndefined();
	expect(ticketFolderAt(path.join(folder, 'missing'), home)).toBeUndefined();
	expect(ticketFolderAt(ticketsDir(home), home)).toBeUndefined();
	// The directory that holds one work dir's ticket folders is not one.
	expect(ticketFolderAt(path.dirname(folder), home)).toBeUndefined();
});
