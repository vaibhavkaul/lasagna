import {describe, test, expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';
import {
	workdirFixture,
	writeExecutable,
	type WorkdirFixture,
} from '../../test/helpers/scan-fixture.ts';
import {tempDir} from '../../test/helpers/temp-dir.ts';
import {runSetupCommand, type SetupCommandDeps} from './command.ts';

// A `claude` on PATH. The tool check is the run without --add-dir; it reports
// the Atlassian read tools. A repo run answers with the values in the file
// named by FAKE_CLAUDE_ANSWERS for that repo, keyed by the added directory's
// name, or with FAKE_CLAUDE_MODE's failure.
const FAKE_CLAUDE = `#!/bin/bash
cat > /dev/null
echo "$PWD" >> "$FAKE_CLAUDE_CALLS"
add_dir=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --add-dir ]]; then add_dir="$2"; shift; fi
  shift
done
init='{"type":"system","subtype":"init","tools":["Read","Grep","mcp__claude_ai_Atlassian__getJiraIssue","mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql"],"mcp_servers":[{"name":"claude.ai Atlassian","status":"connected"}]}'
echo "$init"
if [[ -z "$add_dir" ]]; then
  echo '{"type":"result","subtype":"success","is_error":false,"result":"Read, Grep, mcp__claude_ai_Atlassian__getJiraIssue","total_cost_usd":0.01}'
  exit 0
fi
case "\${FAKE_CLAUDE_MODE:-good}" in
  hang) sleep 60 ;;
  invalid) echo '{"type":"result","subtype":"success","is_error":false,"result":"I could not decide."}' ;;
  *)
    repo=$(basename "$add_dir")
    answer=$(jq -c --arg r "$repo" '.[$r] // {"values":[]}' "$FAKE_CLAUDE_ANSWERS")
    jq -cn --arg a "$answer" '{type:"result",subtype:"success",is_error:false,result:$a,total_cost_usd:0.12}'
    ;;
esac
`;

function value(key: string, held: unknown, confidence = 'high') {
	return {key, value: held, source: 'CLAUDE.md:3', confidence};
}

function setup(
	answers: Record<string, unknown> = {},
	env: Record<string, string> = {},
) {
	const fixture: WorkdirFixture = workdirFixture();
	const calls = path.join(fixture.root, 'claude-calls');
	const answersFile = path.join(fixture.root, 'answers.json');
	fs.writeFileSync(answersFile, JSON.stringify(answers));
	writeExecutable(path.join(fixture.bin, 'claude'), FAKE_CLAUDE);
	const home = tempDir('setup-home-');
	const run = async (argv: string[], deps: Partial<SetupCommandDeps> = {}) => {
		const out: string[] = [];
		const err: string[] = [];
		const exit = await runSetupCommand([fixture.work, ...argv], {
			cwd: fixture.root,
			env: {
				...fixture.env,
				HOME: home,
				FAKE_CLAUDE_CALLS: calls,
				FAKE_CLAUDE_ANSWERS: answersFile,
				JIRA_BASE_URL: 'https://example.atlassian.net',
				...env,
			},
			out: text => out.push(text),
			err: text => err.push(text),
			interactive: false,
			ask: async () => 'q',
			edit: async () => false,
			homeConfigDir: path.join(home, '.lasagna'),
			repoTimeoutMs: 3000,
			toolCheckTimeoutMs: 3000,
			...deps,
		});
		return {exit, out: out.join('\n'), err: err.join('\n')};
	};

	const workdirYml = path.join(fixture.work, '.lasagna', 'workdir.yml');
	return {
		fixture,
		home,
		run,
		workdirYml,
		calls: () =>
			fs.existsSync(calls)
				? fs.readFileSync(calls, 'utf8').trim().split('\n')
				: [],
		written: () => parse(fs.readFileSync(workdirYml, 'utf8')) as any,
	};
}

describe('lasagna setup', () => {
	test('--yes writes only the high-confidence values, as repos.<name>.inferred with their sources', async () => {
		const {run, written} = setup({
			api: {
				values: [
					value('team_prefix', 'API'),
					value('issue_tracker.base_url', 'https://x.atlassian.net', 'low'),
				],
			},
		});

		const {exit, err} = await run(['--yes', '--repo', 'api']);

		expect(exit, err).toBe(0);
		const {inferred} = written().repos.api;
		expect(inferred.config.team_prefix).toBe('API');
		expect(inferred.config.issue_tracker?.base_url).toBeUndefined();
		expect(inferred.sources.team_prefix).toStrictEqual({
			source: 'CLAUDE.md:3',
			confidence: 'high',
		});
	});

	test('every claude starts outside the repos, in a scratch directory under the home directory', async () => {
		const {run, calls, fixture, home} = setup({api: {values: []}});

		await run(['--dry-run', '--repo', 'api']);

		expect(calls().length).toBe(2);
		for (const cwd of calls()) {
			expect(cwd.startsWith(fixture.work)).toBe(false);
			expect(
				fs.realpathSync(path.dirname(cwd)) ===
					fs.realpathSync(path.join(home, '.cache', 'lasagna-setup')),
			).toBe(true);
			expect(fs.existsSync(cwd)).toBe(false);
		}
	});

	test('--dry-run writes nothing, scan.json included', async () => {
		const {run, fixture} = setup({
			api: {values: [value('team_prefix', 'API')]},
		});

		const {exit} = await run(['--dry-run', '--yes']);

		expect(exit).toBe(0);
		expect(fs.existsSync(path.join(fixture.work, '.lasagna'))).toBe(false);
	});

	test('a re-run keeps comments and your own keys, and rewrites only inferred', async () => {
		const {run, workdirYml, written} = setup({
			api: {values: [value('team_prefix', 'FIRST')]},
		});
		await run(['--yes', '--repo', 'api']);
		const text = fs.readFileSync(workdirYml, 'utf8');
		fs.writeFileSync(
			workdirYml,
			`# my work dir\n${text.replace('  api:\n', '  api:\n    # mine\n    default_emoji: x\n')}`,
		);
		fs.writeFileSync(
			path.join(path.dirname(workdirYml), '..', '..', 'answers.json'),
			JSON.stringify({api: {values: [value('team_prefix', 'SECOND')]}}),
		);

		const {exit, err} = await run(['--yes', '--repo', 'api']);

		expect(exit, err).toBe(0);
		const after = fs.readFileSync(workdirYml, 'utf8');
		expect(after).toContain('# my work dir');
		expect(after).toContain('# mine');
		expect(written().repos.api.default_emoji).toBe('x');
		expect(written().repos.api.inferred.config.team_prefix).toBe('SECOND');
	});

	test("an inferred value that clashes with the repo's own config is left out, and the rest written", async () => {
		const {run, fixture, written} = setup({
			api: {
				values: [
					value('team_prefix', 'API'),
					value('post_workspace_init', [{name: 'Install', run: 'make'}]),
				],
			},
		});
		// Still on the old spelling, which can't sit beside the new one.
		fs.writeFileSync(
			path.join(fixture.work, 'api', '.pappardelle.yml'),
			'version: 1\nprofiles:\n  api:\n    display_name: API\npost_worktree_init:\n  - name: Old\n    run: "true"\n',
		);

		const {exit, out} = await run(['--yes', '--repo', 'api']);

		expect(exit, out).toBe(0);
		const {config} = written().repos.api.inferred;
		expect(config.team_prefix).toBe('API');
		expect(config.post_workspace_init).toBeUndefined();
		expect(out).toContain('left out post_workspace_init');
	});

	test("the top level gets a profile and the repos' shared tracker once, for the work dir's own spaces", async () => {
		const {run, workdirYml, written} = setup({});

		const {exit, out} = await run(['--yes']);

		expect(exit, out).toBe(0);
		expect(written().version).toBe(1);
		expect(Object.keys(written().profiles)).toStrictEqual(['work']);
		expect(written().issue_tracker).toStrictEqual({
			provider: 'jira',
			base_url: 'https://example.atlassian.net',
		});
		fs.writeFileSync(
			workdirYml,
			fs
				.readFileSync(workdirYml, 'utf8')
				.replace(/^profiles:\n {2}work:\n.*\n/m, 'profiles:\n  mine: {}\n'),
		);

		await run(['--yes']);

		expect(Object.keys(written().profiles)).toStrictEqual(['mine']);
	});

	test('an existing file with nothing new for its repos still gets the top level', async () => {
		const {run, workdirYml, written} = setup({});
		fs.mkdirSync(path.dirname(workdirYml), {recursive: true});
		fs.writeFileSync(workdirYml, 'repos:\n  api:\n    default_emoji: x\n');

		await run(['--yes', '--no-claude', '--repo', 'web']);
		const first = fs.readFileSync(workdirYml, 'utf8');
		const {out} = await run(['--yes', '--no-claude', '--repo', 'web']);

		expect(Object.keys(written().profiles)).toStrictEqual(['work']);
		expect(fs.readFileSync(workdirYml, 'utf8')).toBe(first);
		expect(out).toContain('Nothing to change');
	});

	test('an answer that is not JSON is reported and leaves the repo as it was', async () => {
		const {run, workdirYml} = setup({}, {FAKE_CLAUDE_MODE: 'invalid'});

		const {exit, out, err} = await run(['--yes', '--repo', 'api']);

		// 3: some repos were reported and left as they were.
		expect(exit).toBe(3);
		expect(`${out}\n${err}`).toContain('not JSON');
		expect(
			fs.existsSync(workdirYml)
				? (parse(fs.readFileSync(workdirYml, 'utf8')) as any)?.repos?.api
						?.inferred?.config?.team_prefix
				: undefined,
		).toBeUndefined();
	});

	test('a claude that hangs is given up on and named', async () => {
		const {run} = setup({}, {FAKE_CLAUDE_MODE: 'hang'});

		const {out, err} = await run(['--dry-run', '--repo', 'api'], {
			repoTimeoutMs: 1000,
		});

		expect(`${out}\n${err}`).toContain('timed out');
	});

	test('the Atlassian tools the check finds are the ones the repo runs may use', async () => {
		const {run} = setup({api: {values: []}});

		const {out} = await run(['--dry-run', '--repo', 'api']);

		expect(out).toContain('Atlassian');
	});

	test('--no-claude runs no claude and proposes the scan defaults', async () => {
		const {run, calls} = setup();

		const {exit, out} = await run(['--no-claude', '--dry-run']);

		expect(exit).toBe(0);
		expect(calls()).toStrictEqual([]);
		expect(out).toContain('team_prefix');
	});
});
