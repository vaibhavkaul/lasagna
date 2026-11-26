import {Database} from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {stringify} from 'yaml';
import {sqliteRun} from '../test/helpers/state.ts';
import {setup} from '../test/helpers/idow-fixture.ts';

test('a reopened space resumes the session its agent recorded', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			agent_profiles: {
				codex: {command: 'codex', resume_args: 'resume {session_id}'},
			},
			profiles: {other: {display_name: 'Other', agent_profile: 'codex'}},
		}),
	);
	const sessionsPath = path.join(
		fixture.home,
		'.pappardelle/repos/main checkout/space-state/test-abc.agent-sessions.json',
	);
	const record = (agentSessions: Record<string, string>) => {
		fs.mkdirSync(path.dirname(sessionsPath), {recursive: true});
		fs.writeFileSync(
			sessionsPath,
			JSON.stringify(
				Object.fromEntries(
					Object.entries(agentSessions).map(([profile, id]) => [
						profile,
						{session_id: id, pid: 1},
					]),
				),
			),
		);
	};
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	// An existing issue resumes its conversation even in a recreated worktree.
	record({codex: 'thread-1'});
	await fixture.run({profile: 'other'});
	expect(launchArg('--agent-resume-args')).toBe('resume thread-1');

	fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
		recursive: true,
	});
	record({codex: 'thread-1'});
	await fixture.run({open: true});
	expect(launchArg('--agent-resume-args')).toBe('resume thread-1');
	expect(launchArg('--agent-command')).toBe('codex');

	// An id recorded by another agent profile is not this one's conversation.
	record({claude: 'thread-2'});
	await fixture.run({open: true});
	expect(launchArg('--agent-resume-args')).toBe('');

	// A hand-edited, non-string id is skipped, as the TUI does.
	fs.writeFileSync(
		sessionsPath,
		JSON.stringify({codex: {session_id: 123, pid: 1}}),
	);
	await fixture.run({open: true});
	expect(launchArg('--agent-resume-args')).toBe('');

	// An override launch resumes its own agent profile's conversation, and the
	// profile's agent still finds its own afterwards.
	record({codex: 'thread-1', claude: 'thread-2'});
	await fixture.run({open: true, agentProfile: 'claude'});
	expect(launchArg('--agent-resume-args')).toBe('--resume thread-2');
	await fixture.run({open: true});
	expect(launchArg('--agent-resume-args')).toBe('resume thread-1');
});

// The JSON files only mirror the database while the flag exists, so a
// reopen must read the profile from the stores, not from the file.
if (sqliteRun) {
	test('a reopen picks the profile the database holds when no state file mirrors it', async () => {
		const fixture = setup();
		fs.writeFileSync(
			path.join(fixture.main, '.pappardelle.local.yml'),
			stringify({profiles: {other: {display_name: 'Other'}}}),
		);
		const stateFile = path.join(
			fixture.home,
			'.pappardelle/repos/main checkout/space-state/test-abc.json',
		);
		await fixture.run({profile: 'other'});
		fs.rmSync(stateFile);
		const db = new Database(path.join(fixture.home, '.pappardelle/state.db'));
		db.query('DELETE FROM json_sync WHERE path = ?').run(stateFile);
		db.close();
		fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
			recursive: true,
		});

		const output = await fixture.run();
		expect(output.includes('Profile:   Other'), output).toBe(true);
	});
}

// Taking an unreadable store for a space with no saved profile would launch
// the default agent in a space created with another.
test('a state store that cannot be read stops idow before any session starts', async () => {
	const fixture = setup();
	fs.mkdirSync(
		path.join(
			fixture.home,
			'.pappardelle/repos/main checkout/space-state/test-abc.json',
		),
		{recursive: true},
	);

	const error = await rejectionOf(fixture.run());
	expect(String(error)).toMatch(/Could not look up workspace test-abc/);
	expect(fs.existsSync(fixture.launchArgs)).toBe(false);
});

test('a reopened claude space with no recorded session continues its conversation', async () => {
	const fixture = setup();
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	// An existing issue continues even in a recreated worktree; only a new
	// issue launches fresh.
	await fixture.run({});
	expect(launchArg('--agent-resume-args')).toBe('--continue');

	fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
		recursive: true,
	});
	await fixture.run({open: true});
	expect(launchArg('--agent-resume-args')).toBe('--continue');
});

test('a claude space with no recorded session keeps its other resume flags', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			agent_profiles: {
				claude: {
					command: 'claude',
					resume_args: '--resume {session_id} --fork-session',
				},
			},
		}),
	);
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	await fixture.run();
	expect(launchArg('--agent-resume-args')).toBe('--continue --fork-session');
});
