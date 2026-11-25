import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {testState} from '../test/helpers/state.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {waitForAgentStart} from './agent-start.ts';
import {runOpenSpaceCommand} from './open-space-command.ts';
import {parseStatusPane} from './program-status-monitor.ts';
import {newSpaceIdentity} from './space-identity.ts';
import type {OuterTmuxRunner} from './tmux.ts';

test.serial(
	'an agent that is not confirmed exits 3 and leaves the space registered',
	async t => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-wait-'));
		const {registry} = testState(t).daos;
		t.teardown(() => {
			fs.rmSync(dir, {recursive: true, force: true});
		});
		const idow = path.join(dir, 'idow');
		fs.writeFileSync(idow, '#!/bin/sh\necho "Workspace STE-5 is ready!"\n', {
			mode: 0o755,
		});
		const asked: Array<[string, number]> = [];
		const before = Date.now();
		const status = await runOpenSpaceCommand({
			command: idow,
			prompt: 'STE-5',
			issueKey: null,
			resume: true,
			cwd: dir,
			env: process.env,
			registry,
			async waitForAgent(issueKey, since) {
				asked.push([issueKey, since]);
				return false;
			},
		});
		t.is(status, 3);
		t.deepEqual(registry.openSpaces(), ['STE-5']);
		t.is(asked.length, 1);
		t.is(asked[0]![0], 'STE-5');
		t.true(asked[0]![1] >= before && asked[0]![1] <= Date.now());
	},
);

test.serial(
	'runOpenSpaceCommand confirms an idle OSC space via waitForAgentStart and exits 0',
	async t => {
		const dir = tempDir(t, 'open-wait-osc-');
		const state = testState(t);
		const {registry, spaceIdentities, claudeStatus} = state.daos;
		const idow = path.join(dir, 'idow');
		fs.writeFileSync(idow, '#!/bin/sh\necho "Workspace STE-6 is ready!"\n', {
			mode: 0o755,
		});
		const identity = newSpaceIdentity({
			repo: state.repo,
			key: 'STE-6',
			worktreePath: path.join(dir, 'STE-6'),
			socket: 'pappardelle_inner',
		});
		await spaceIdentities.record(identity);
		const paneLine = '%8\t99\t0\t1\t99.live';
		const pane = parseStatusPane(paneLine, identity.tmux.socket)!;
		const runner: OuterTmuxRunner = args =>
			args[0] === 'list-panes'
				? {status: 0, stdout: `11\t%8\t${paneLine}\n`}
				: {status: 1, stdout: ''};

		const status = await runOpenSpaceCommand({
			command: idow,
			prompt: 'STE-6',
			issueKey: 'STE-6',
			resume: true,
			cwd: dir,
			env: process.env,
			registry,
			waitForAgent: (issueKey, since) =>
				waitForAgentStart({
					claudeStatus,
					programStatus: {
						read: async () => ({
							version: 1,
							repo: state.repo,
							key: issueKey,
							pane,
							authoritative: true,
							exited: false,
							updatedAt: since - 5000,
							records: [],
							info: {status: 'idle', app: 'antigravity'},
						}),
					},
					spaceIdentities,
					runner,
					issueKey,
					statusKey: `${state.repo}-${issueKey}`,
					worktree: identity.worktreePath,
					since,
					timeoutMs: 0,
				}),
		});
		t.is(status, 0);
	},
);
