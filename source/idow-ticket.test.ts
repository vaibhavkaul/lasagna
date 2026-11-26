// What idow does for a ticket space: a repo's worktree made in the ticket
// folder and nothing more, and the lead agent started for the work dir itself.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {setup} from '../test/helpers/idow-fixture.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';

test('idow --worktree-only makes the worktree where it is told, sets it up, and stops there', async () => {
	const fixture = setup(true);
	const repo = path.basename(fixture.main);
	const target = path.join(
		fixture.home,
		'.lasagna',
		'worktrees',
		'_tickets',
		'test-abc',
		repo,
	);
	const output = await fixture.run({worktreeOnly: target});

	expect(output.includes(`Worktree:  ${target}`), output).toBe(true);
	// A real worktree of the repo, on the branch named after the issue.
	expect(fs.lstatSync(path.join(target, '.git')).isFile()).toBe(true);
	expect(
		execFileSync('git', ['-C', target, 'branch', '--show-current'], {
			encoding: 'utf8',
		}).trim(),
	).toBe('test-abc');
	// Set up as any new worktree of the repo is: its init commands ran, the
	// profile's too, and its local config came along.
	expect(fs.readFileSync(path.join(target, '.env'), 'utf8')).toBe(
		'FROM_MAIN=1\n',
	);
	expect(fs.existsSync(path.join(target, 'profile.env'))).toBe(true);
	expect(fs.existsSync(path.join(target, '.pappardelle.local.yml'))).toBe(true);

	// It is no space of the repo: nothing is recorded, and no session starts.
	expect(fs.existsSync(fixture.launchArgs)).toBe(false);
	const state = path.join(fixture.home, '.lasagna', 'repos', repo);
	expect(fs.existsSync(path.join(state, 'space-state', 'test-abc.json'))).toBe(
		false,
	);
	expect(fs.existsSync(path.join(state, 'open-spaces.json'))).toBe(false);
	expect(fs.existsSync(fixture.workspace)).toBe(false);
	// The line a caller reads for a space that is up is not printed.
	expect(output).not.toContain('Workspace test-abc is ready!');

	// Asked again, there is nothing left to do.
	const again = await fixture.run({worktreeOnly: target});
	expect(again.includes(`Worktree exists: ${target}`), again).toBe(true);
});

test('--worktree-only refuses a path that is not absolute', async () => {
	const fixture = setup();
	const error = await rejectionOf(fixture.run({worktreeOnly: 'relative/path'}));
	expect(error.message).toContain('--worktree-only needs an absolute path');
});

test('idow for a work dir itself starts the lead agent in the ticket folder, under the pseudo-repo', async () => {
	const fixture = setup();
	const work = path.join(path.dirname(fixture.main), 'work');
	fs.mkdirSync(path.join(work, '.lasagna'), {recursive: true});
	fs.writeFileSync(
		path.join(work, '.lasagna', 'workdir.yml'),
		fixture.config('The work dir'),
	);
	// The ticket folder is there already, holding the repos\u2019 worktrees.
	const folder = path.join(
		fixture.home,
		'.lasagna',
		'worktrees',
		'_tickets',
		'test-abc',
	);
	fs.mkdirSync(path.join(folder, 'api'), {recursive: true});

	const output = await fixture.run({
		cwd: work,
		extraEnv: {
			LASAGNA_PROJECT_ROOT: work,
			LASAGNA_MAIN_REPO_ROOT: work,
			LASAGNA_WORKDIR_REPO: '@work',
			LASAGNA_AGENT_PROMPT: 'Read HANDOFF.md first; then carry on',
		},
	});

	expect(output.includes('Workspace test-abc is ready!'), output).toBe(true);
	expect(output.includes(`Worktree exists: ${folder}`), output).toBe(true);
	expect(output.includes('Profile:   The work dir'), output).toBe(true);
	const args = fs.readFileSync(fixture.launchArgs, 'utf8');
	// The space is the work dir\u2019s own, in the folder.
	expect(args).toContain('--repo-name\n@work\n');
	expect(args).toContain(`--worktree\n${folder}\n`);
	expect(args).toContain('--agent-session\nagent-@work-test-abc\n');
	// A shell for its companion: the folder is no checkout for a git UI.
	expect(args).toContain('--companion-command\n\n');
	// It starts on the handoff, not on the issue key.
	expect(args).toContain('--prompt\nRead HANDOFF.md first; then carry on\n');
	expect(args).not.toContain('--init-cmd');
	expect(
		fs.existsSync(
			path.join(
				fixture.home,
				'.lasagna',
				'repos',
				'@work',
				'space-state',
				'test-abc.json',
			),
		),
	).toBe(true);
	// Its init commands are a repo\u2019s business, run for each worktree.
	expect(fs.existsSync(path.join(folder, '.env'))).toBe(false);
});

test('without a handoff the lead agent starts on the issue, as any space\u2019s agent does', async () => {
	const fixture = setup();
	const work = path.join(path.dirname(fixture.main), 'work');
	fs.mkdirSync(path.join(work, '.lasagna'), {recursive: true});
	fs.writeFileSync(
		path.join(work, '.lasagna', 'workdir.yml'),
		`${fixture.config('The work dir')}initialization_command: do\n`,
	);
	fs.mkdirSync(
		path.join(fixture.home, '.lasagna', 'worktrees', '_tickets', 'test-abc'),
		{
			recursive: true,
		},
	);
	await fixture.run({
		cwd: work,
		extraEnv: {
			LASAGNA_PROJECT_ROOT: work,
			LASAGNA_MAIN_REPO_ROOT: work,
			LASAGNA_WORKDIR_REPO: '@work',
		},
	});
	const args = fs.readFileSync(fixture.launchArgs, 'utf8');
	expect(args).toContain('--init-cmd\n/do\n');
	expect(args).not.toContain('--prompt');
});
