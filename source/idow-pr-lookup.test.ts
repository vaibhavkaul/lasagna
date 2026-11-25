/* eslint-disable no-template-curly-in-string -- These are idow shell templates. */
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {stringify} from 'yaml';
import {setup} from '../test/helpers/idow-fixture.ts';

test('adding commands does not add YAML parser processes', async () => {
	const fixture = setup();
	// Reopening an existing space reads its saved profile, which the first run
	// writes, so compare two reopens.
	await fixture.run();
	fs.writeFileSync(fixture.configCalls, '');
	await fixture.run();
	const count = fs
		.readFileSync(fixture.configCalls, 'utf8')
		.trim()
		.split('\n').length;
	fs.writeFileSync(fixture.configCalls, '');
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: Array.from({length: 20}, () => ({run: ':'})),
		}),
	);
	await fixture.run();
	expect(
		fs.readFileSync(fixture.configCalls, 'utf8').trim().split('\n').length,
	).toBe(count);
});

for (const consumer of ['profile vars', 'post-create hook']) {
	test(`PR lookup covers ${consumer}`, async () => {
		const fixture = setup();
		fs.appendFileSync(
			path.join(fixture.main, '.pappardelle.local.yml'),
			stringify({
				profiles: {
					dev: {
						links: [],
						...(consumer === 'profile vars'
							? {
									vars: {
										SAVE_PR: 'printf "%s" "$PR_URL" > "${WORKTREE_PATH}/pr"',
									},
									commands: [{run: '${SAVE_PR}'}],
								}
							: {}),
					},
				},
				hooks: {
					post_workspace_create:
						consumer === 'post-create hook'
							? [{run: 'printf "%s" "${MR_URL}" > "${WORKTREE_PATH}/pr"'}]
							: [],
				},
			}),
		);
		await fixture.run({open: true});
		expect(fs.readFileSync(path.join(fixture.workspace, 'pr'), 'utf8')).toBe(
			'https://github.com/test/repo/pull/1',
		);
	});
}

for (const consumer of ['links', 'apps']) {
	test(`PR lookup sees YAML aliases in ${consumer} after merging layers`, async () => {
		const fixture = setup();
		const entry =
			consumer === 'links'
				? "  - url: '${PR_URL}'\n    if_set: PR_URL"
				: '  - name: Save PR\n    command: \'printf %s "${PR_URL}" > "${WORKTREE_PATH}/pr"\'\n    if_set: PR_URL';
		fs.writeFileSync(
			path.join(fixture.main, '.pappardelle.yml'),
			`common_entries: &entries\n${entry}\nversion: 1\nteam_prefix: test\nissue_tracker:\n  provider: beads\ndefault_profile: dev\nterminal:\n  app: none\nprofiles:\n  dev:\n    display_name: Dev\n${consumer === 'apps' ? '    links: []\n' : ''}    ${consumer}: *entries\n`,
		);
		const output = await fixture.run({open: true});
		const url = 'https://github.com/test/repo/pull/1';
		expect(output.includes(`PR:        ${url}`), output).toBe(true);
		expect(
			consumer === 'links'
				? fs.readFileSync(fixture.openCalls, 'utf8').trim()
				: fs.readFileSync(path.join(fixture.workspace, 'pr'), 'utf8'),
		).toBe(url);
	});
}

test('a failed PR consumer inspection falls back to VCS lookup', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({profiles: {dev: {links: []}}}),
	);
	const output = await fixture.run({
		open: true,
		extraEnv: {IDOW_TEST_FAIL_PR_INSPECTION: 'true'},
	});
	expect(fs.existsSync(fixture.vcsCalls)).toBe(true);
	expect(
		output.includes('PR:        https://github.com/test/repo/pull/1'),
	).toBe(true);
});

test('block-scalar launch settings strip trailing newlines', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		`claude:
  initialization_command: |+
    do

  model: |
    opus
  effort: >
    high
companion_command: |
  echo companion
`,
	);
	await fixture.run();
	const args = fs
		.readFileSync(fixture.launchArgs, 'utf8')
		.split('\n')
		.slice(0, -1);
	for (const [flag, value] of [
		['--init-cmd', '/do'],
		['--agent-launch-flags', '--model opus --effort high'],
		['--companion-command', 'echo companion'],
	]) {
		expect(args.includes(flag)).toBe(true);
		expect(args[args.indexOf(flag) + 1]).toBe(value);
	}
});

test('block-scalar app/link conditions and titles keep the previous field behavior', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		`profiles:
  dev:
    apps:
      - name: |
          Block app
        command: |
          printf '%s' "\${PR_URL}" > "\${WORKTREE_PATH}/app"
        if_set: |
          PR_URL
    links:
      - title: |+
          Block link

        url: |
          \${PR_URL}
        if_set: |
          PR_URL
`,
	);
	const output = await fixture.run({open: true});
	const url = 'https://github.com/test/repo/pull/1';
	expect(fs.readFileSync(path.join(fixture.workspace, 'app'), 'utf8')).toBe(
		url,
	);
	expect(fs.readFileSync(fixture.openCalls, 'utf8')).toBe(`${url}\n`);
	expect(output.includes(`Link: Block link -> ${url}`), output).toBe(true);
	expect(output.includes('Block app opened (command)'), output).toBe(true);
});

// A Pappardelle that starts idow lists the space afterwards, so idow records
// it before any session exists (source/space-registry-sqlite.ts). Lookups are
// not recorded, and a CLI that works answers them from what it recorded.
