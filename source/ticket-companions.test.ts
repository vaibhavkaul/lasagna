import {test, expect} from 'bun:test';
import {DEFAULT_COMPANION_COMMAND, type ConfigLoad} from './config.ts';
import type {RepoContext} from './repo-context.ts';
import {newSpaceIdentity} from './space-identity.ts';
import {ticketCompanionSplits, ticketPaneName} from './ticket-companions.ts';
import {createCompanionSplit, type OuterTmuxRunner} from './tmux.ts';

const repo = (name: string, load: ConfigLoad) =>
	({name, readConfig: () => load}) as unknown as RepoContext;

test('a repo\u2019s pane is called by its name, as far as a pane name can be', () => {
	expect(ticketPaneName('tts-business')).toBe('tts-business');
	expect(ticketPaneName('Data_Eng.v2')).toBe('data-eng-v2');
	expect(ticketPaneName('.dotfiles')).toBe('dotfiles');
	expect(ticketPaneName('___')).toBe('repo');
});

test('each repo of a ticket gets a companion pane in its own worktree, with its own command', () => {
	expect(
		ticketCompanionSplits([
			{
				repo: repo('tts-business', {
					kind: 'valid',
					config: {version: 1, profiles: {}, companion_command: 'lazygit'},
				} as ConfigLoad),
				worktreePath: '/tickets/B2B-5/tts-business',
			},
			// A repo with no config, or an invalid one, gets the usual git UI.
			{
				repo: repo('appian-server', {kind: 'missing'} as ConfigLoad),
				worktreePath: '/tickets/B2B-5/appian-server',
			},
			{
				repo: repo('data-eng', {
					kind: 'valid',
					config: {version: 1, profiles: {}, companion_command: ''},
				} as ConfigLoad),
				worktreePath: '/tickets/B2B-5/data-eng',
			},
		]),
	).toEqual([
		{
			name: 'tts-business',
			command: 'lazygit',
			split: 'down',
			cwd: '/tickets/B2B-5/tts-business',
		},
		{
			name: 'appian-server',
			command: DEFAULT_COMPANION_COMMAND,
			split: 'down',
			cwd: '/tickets/B2B-5/appian-server',
		},
		// An empty command is a plain shell, there.
		{
			name: 'data-eng',
			command: '',
			split: 'down',
			cwd: '/tickets/B2B-5/data-eng',
		},
	]);
});

test('a split given a directory starts there; one given none starts where the companion did', () => {
	const identity = newSpaceIdentity({
		repo: '@work',
		key: 'B2B-5',
		worktreePath: '/tickets/B2B-5',
		socket: 'test',
	});
	const started: string[][] = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'display-message')
			return {status: 0, stdout: '/tickets/B2B-5\n'};
		started.push([...args]);
		return {status: 0, stdout: ''};
	};
	const directoryOf = (args: string[]) => args[args.indexOf('-c') + 1];

	expect(
		createCompanionSplit(
			identity,
			{name: 'api', command: '', split: 'down', cwd: '/tickets/B2B-5/api'},
			{runner},
		),
	).toEqual({ok: true, session: 'companion-@work-B2B-5~api'});
	expect(directoryOf(started[0]!)).toBe('/tickets/B2B-5/api');
	// Its session is the ticket space's own, whatever repo it stands in.
	expect(started[0]).toContain('LASAGNA_REPO=@work');
	expect(started[0]).toContain('LASAGNA_SPACE=B2B-5');

	createCompanionSplit(
		identity,
		{name: 'logs', command: '', split: 'down'},
		{runner},
	);
	expect(directoryOf(started[1]!)).toBe('/tickets/B2B-5');
});
