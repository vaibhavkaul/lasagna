import {describe, test, expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	API_PRS,
	initRepo,
	workdirFixture,
	writeExecutable,
} from '../test/helpers/workdir-fixture.ts';
import {
	WORKDIR_SCAN_FILE,
	buildPrefixMap,
	collectTicketEvidence,
	extractTicketKeys,
	findCheckouts,
	formatScan,
	leadingTicketKeys,
	runScanCommand,
	scanWorkdir,
	topLanguages,
	type PrefixEvidence,
	type ScanResult,
} from './workdir-scan.ts';

describe('ticket keys', () => {
	test('a key is taken from the branch styles in use', () => {
		expect(extractTicketKeys('B2B-3127__biz-remittance-credit')).toStrictEqual([
			'B2B-3127',
		]);
		expect(extractTicketKeys('PLAT-5751-reset-link')).toStrictEqual([
			'PLAT-5751',
		]);
		expect(extractTicketKeys('vk/B2B-585/PL-1/payment-links')).toStrictEqual([
			'B2B-585',
			'PL-1',
		]);
		expect(
			extractTicketKeys('[PLAT-5775][PLAT-5832] Keep secrets out (#21433)'),
		).toStrictEqual(['PLAT-5775', 'PLAT-5832']);
	});

	test('a key needs an upper-case prefix of two or more and a number', () => {
		for (const text of ['b2b-12-thing', 'A-1', 'ABC-', 'ABC-x1', 'release-12'])
			expect(extractTicketKeys(text), text).toStrictEqual([]);
	});

	test('a key is not cut out of a longer word or number', () => {
		for (const text of ['ABC-12x', 'xABC-12', '9ABC-12', 'ABC-12a-thing'])
			expect(extractTicketKeys(text), text).toStrictEqual([]);
		expect(extractTicketKeys('fix_ABC-12_now')).toStrictEqual(['ABC-12']);
	});

	test('prose that is shaped like a key is still extracted, to be judged later', () => {
		expect(
			extractTicketKeys('Hash with SHA-256, encode as UTF-8, date as ISO-8601'),
		).toStrictEqual(['SHA-256', 'UTF-8', 'ISO-8601']);
	});

	test('a title opens with the keys before its first word', () => {
		expect(leadingTicketKeys('[PLAT-1][B2B-2] Fix INC-3')).toStrictEqual([
			'PLAT-1',
			'B2B-2',
		]);
		expect(leadingTicketKeys('SHLD-14 Add two monitors')).toStrictEqual([
			'SHLD-14',
		]);
		expect(leadingTicketKeys('PLAT-9: tidy')).toStrictEqual(['PLAT-9']);
		expect(leadingTicketKeys('Revert "[PLAT-1] Fix"')).toStrictEqual([]);
		expect(leadingTicketKeys('Use SHA-256')).toStrictEqual([]);
	});
});

describe('ticket evidence', () => {
	const evidence = collectTicketEvidence({
		branches: ['main', 'B2B-1__a', 'B2B-1-again', 'B2B-2-b', 'fix-UTF-8'],
		localBranches: ['main', 'B2B-2-b'],
		commits: ['B2B-1 B2B-3 one commit, two keys', 'Use SHA-256', 'PLAT-9 x'],
		prs: [
			{title: '[OPS-4] Rotate', body: 'See ISP-14 and B2B-1', headRefName: 'x'},
			{title: 'Mentions QA-5 late', body: null, headRefName: 'DEV-6-thing'},
		],
	});

	test('each branch, commit and PR counts once for a prefix', () => {
		expect(evidence['B2B']).toMatchObject({branches: 3, commits: 1, prs: 1});
		expect(evidence['B2B']!.keys).toStrictEqual({
			'B2B-1': 4,
			'B2B-2': 1,
			'B2B-3': 1,
		});
	});

	test('the keys of local branches are kept apart', () => {
		expect(evidence['B2B']!.localKeys).toStrictEqual(['B2B-2']);
		expect(evidence['UTF']!.localKeys).toStrictEqual([]);
	});

	test('a prefix is named by a branch, a PR branch or the start of a PR title', () => {
		const named = Object.entries(evidence)
			.filter(([, {named}]) => named)
			.map(([prefix]) => prefix)
			.sort();
		// B2B and UTF from branch names, DEV from a PR's branch, OPS from a
		// title's start.
		expect(named).toStrictEqual(['B2B', 'DEV', 'OPS', 'UTF']);
		// A commit subject, the rest of a title and a PR body name nothing.
		for (const prefix of ['SHA', 'PLAT', 'QA', 'ISP'])
			expect(evidence[prefix], prefix).toMatchObject({named: false});
	});
});

function found(
	keys: string[],
	options: {local?: string[]; named?: boolean} = {},
): PrefixEvidence {
	return {
		keys: Object.fromEntries(keys.map(key => [key, 1])),
		localKeys: options.local ?? [],
		branches: keys.length,
		commits: 0,
		prs: 0,
		named: options.named ?? true,
	};
}

describe('the prefix map', () => {
	test('each repo gets its share of the prefix keys, largest first', () => {
		const {prefixes} = buildPrefixMap([
			{name: 'web', evidence: {PLAT: found(['PLAT-1'])}},
			{
				name: 'api',
				evidence: {PLAT: found(['PLAT-1', 'PLAT-2', 'PLAT-3'])},
			},
		]);
		expect(prefixes['PLAT']).toStrictEqual({
			keys: 4,
			localKeys: 0,
			branches: 4,
			commits: 0,
			prs: 0,
			defaultRepo: 'api',
			repos: {api: 0.75, web: 0.25},
		});
		expect(Object.keys(prefixes['PLAT']!.repos)).toStrictEqual(['api', 'web']);
	});

	test('local branches decide the default repo once they name three keys', () => {
		const everyone = ['PLAT-1', 'PLAT-2', 'PLAT-3', 'PLAT-4', 'PLAT-5'];
		const mine = ['PLAT-7', 'PLAT-8', 'PLAT-9'];
		const map = (local: string[]) =>
			buildPrefixMap([
				{name: 'infra', evidence: {PLAT: found(everyone)}},
				{name: 'api', evidence: {PLAT: found(local, {local})}},
			]).prefixes['PLAT']!;

		expect(map(mine)).toMatchObject({
			defaultRepo: 'api',
			repos: {infra: 0.625, api: 0.375},
			localRepos: {api: 1},
		});
		// Two could be someone else's branches, checked out to review.
		expect(map(mine.slice(0, 2))).toMatchObject({
			defaultRepo: 'infra',
			localRepos: {api: 1},
		});
	});

	test('a prefix no branch or PR title names is dropped, whichever repo has it', () => {
		const {prefixes, dropped} = buildPrefixMap([
			{
				name: 'api',
				evidence: {
					UTF: found(['UTF-8'], {named: false}),
					INC: found(['INC-739'], {named: false}),
				},
			},
			{name: 'web', evidence: {INC: found(['INC-739', 'INC-740'])}},
		]);
		expect(Object.keys(prefixes)).toStrictEqual(['INC']);
		expect(prefixes['INC']!.repos).toStrictEqual({web: 0.667, api: 0.333});
		expect(dropped).toStrictEqual({
			UTF: {keys: 1, localKeys: 0, branches: 1, commits: 0, prs: 0},
		});
	});

	test('prefixes come out with the most keys first', () => {
		const {prefixes} = buildPrefixMap([
			{
				name: 'api',
				evidence: {
					AB: found(['AB-1']),
					CD: found(['CD-1', 'CD-2']),
					AA: found(['AA-1']),
				},
			},
		]);
		expect(Object.keys(prefixes)).toStrictEqual(['CD', 'AA', 'AB']);
	});
});

test('languages are ranked by tracked files, over the files with a known language', () => {
	expect(
		topLanguages(['a.ts', 'b.tsx', 'c.kt', 'd.png', 'Makefile', 'x/e.TS']),
	).toStrictEqual([
		{language: 'TypeScript', files: 3, share: 0.75},
		{language: 'Kotlin', files: 1, share: 0.25},
	]);
	expect(topLanguages(['LICENSE'])).toStrictEqual([]);
});

describe('finding checkouts', () => {
	test('checkouts are found two levels down, and the rest is passed over with a reason', () => {
		const {work} = workdirFixture();
		const {checkouts, skipped} = findCheckouts(work, 2);
		const relative = (file: string) => path.relative(work, file);
		expect(checkouts.map(file => relative(file))).toStrictEqual([
			'api',
			'group/tool',
			'web',
		]);
		expect(
			skipped.map(({path: file, reason}) => `${reason} ${relative(file)}`),
		).toStrictEqual([
			'hidden .cache',
			'nested api/nested',
			'worktree api-wt-PLAT-1',
			'symlink link',
			'bare mirror.git',
			'node_modules node_modules',
		]);
	});

	test('--depth limits how far down it looks', () => {
		const {work} = workdirFixture();
		const relative = (file: string) => path.relative(work, file);
		const shallow = findCheckouts(work, 1);
		expect(shallow.checkouts.map(file => relative(file))).toStrictEqual([
			'api',
			'web',
		]);
		// A checkout's own directories are past the limit too.
		expect(shallow.skipped.map(({reason}) => reason)).not.toContain('nested');
		expect(findCheckouts(work, 0).checkouts).toStrictEqual([]);
	});

	test('a directory that is itself a checkout is the one repo', () => {
		const {work} = workdirFixture();
		const api = path.join(work, 'api');
		expect(findCheckouts(api, 2)).toStrictEqual({
			checkouts: [api],
			skipped: [{path: path.join(api, 'nested'), reason: 'nested'}],
		});
	});

	test('a checkout named like the work dir pseudo-repo is refused', () => {
		const work = tempDir('lasagna-scan-');
		initRepo(path.join(work, '@work'));
		expect(findCheckouts(work, 2)).toStrictEqual({
			checkouts: [],
			skipped: [{path: path.join(work, '@work'), reason: 'invalid_name'}],
		});
	});
});

describe('scanning a work dir', () => {
	test('each repo gets its facts', async () => {
		const fixture = workdirFixture();
		const scan = await scanWorkdir(fixture.work, {env: fixture.env});
		expect(
			scan.repos.map(({tickets, topPrefix, errors, ...facts}) => facts),
		).toStrictEqual([
			{
				name: 'api',
				path: path.join(fixture.work, 'api'),
				relativePath: 'api',
				originUrl: 'https://github.com/acme/api.git',
				github: 'acme/api',
				defaultBranch: 'main',
				defaultBranchSource: 'origin/HEAD',
				// .pappardelle.yml is the YAML.
				languages: [
					{language: 'TypeScript', files: 3, share: 0.43},
					{language: 'Markdown', files: 2, share: 0.29},
					{language: 'Python', files: 1, share: 0.14},
					{language: 'YAML', files: 1, share: 0.14},
				],
				files: {
					'.pappardelle.yml': true,
					'CLAUDE.md': true,
					'AGENTS.md': false,
					readme: 'README.md',
				},
			},
			{
				name: 'tool',
				path: path.join(fixture.work, 'group', 'tool'),
				relativePath: 'group/tool',
				originUrl: 'git@github.com:acme/tool.git',
				github: 'acme/tool',
				defaultBranch: 'main',
				defaultBranchSource: 'fallback',
				languages: [],
				files: {
					'.pappardelle.yml': false,
					'CLAUDE.md': false,
					'AGENTS.md': false,
					readme: null,
				},
			},
			{
				name: 'web',
				path: path.join(fixture.work, 'web'),
				relativePath: 'web',
				originUrl: null,
				github: null,
				defaultBranch: 'master',
				defaultBranchSource: 'fallback',
				languages: [{language: 'Kotlin', files: 1, share: 1}],
				files: {
					'.pappardelle.yml': false,
					'CLAUDE.md': false,
					'AGENTS.md': false,
					readme: null,
				},
			},
		]);
	});

	test('ticket keys are counted from branches, recent commits and PRs', async () => {
		const fixture = workdirFixture();
		const scan = await scanWorkdir(fixture.work, {env: fixture.env});
		const [api, tool, web] = scan.repos;

		// main, the two key branches, the worktree's and one only on origin.
		expect(api!.tickets.read).toStrictEqual({
			branches: 5,
			commits: 4,
			prs: API_PRS.length,
		});
		expect(api!.tickets.prefixes).toStrictEqual({
			PLAT: {
				// PLAT-12 is in a commit only; the other two are local branches.
				keys: 3,
				localKeys: 2,
				branches: 2,
				commits: 1,
				prs: 0,
				examples: ['PLAT-5751', 'PLAT-12', 'PLAT-1'],
			},
			B2B: {
				keys: 2,
				localKeys: 1,
				// The local and the origin B2B-3127__payments are one branch.
				branches: 2,
				commits: 1,
				prs: 1,
				examples: ['B2B-3127', 'B2B-9'],
			},
			OPS: {
				keys: 1,
				localKeys: 0,
				branches: 0,
				commits: 0,
				prs: 1,
				examples: ['OPS-4'],
			},
		});
		expect(api!.topPrefix).toBe('PLAT');
		expect(web!.tickets.prefixes).toMatchObject({PLAT: {keys: 1}});
		expect(tool!.tickets.prefixes).toMatchObject({ONC: {keys: 1}});

		expect(scan.prefixes).toMatchObject({
			PLAT: {
				keys: 4,
				localKeys: 3,
				defaultRepo: 'api',
				repos: {api: 0.75, web: 0.25},
				localRepos: {api: 0.667, web: 0.333},
			},
			B2B: {keys: 2, defaultRepo: 'api', repos: {api: 1}},
			ONC: {keys: 1, defaultRepo: 'tool', repos: {tool: 1}},
			OPS: {keys: 1, defaultRepo: 'api', repos: {api: 1}},
		});
		expect(Object.keys(scan.prefixes)).toStrictEqual([
			'PLAT',
			'B2B',
			'ONC',
			'OPS',
		]);
	});

	test('prose shaped like a key and commits past 180 days are left out', async () => {
		const fixture = workdirFixture();
		const scan = await scanWorkdir(fixture.work, {env: fixture.env});
		// UTF-8 and SHA-256 are in commit subjects, SHA-256, INC-739 and
		// ISO-8601 in PR bodies.
		expect(Object.keys(scan.droppedPrefixes).sort()).toStrictEqual([
			'INC',
			'ISO',
			'SHA',
			'UTF',
		]);
		expect(scan.droppedPrefixes['SHA']).toMatchObject({commits: 1, prs: 1});
		expect(JSON.stringify(scan)).not.toContain('OLD');
	});

	test('gh is asked for the PRs of GitHub repos only, and its failure stays with the repo', async () => {
		const fixture = workdirFixture();
		const scan = await scanWorkdir(fixture.work, {env: fixture.env});
		expect(fixture.ghCalls()).toHaveLength(2);
		for (const call of fixture.ghCalls()) {
			expect(call).toMatch(
				/^pr list --repo acme\/(api|tool) --state all --limit 200 --json title,body,headRefName$/,
			);
		}

		const [api, tool, web] = scan.repos;
		expect(api!.errors).toStrictEqual([]);
		expect(tool!.errors).toStrictEqual([
			'gh pr list failed: HTTP 404: Not Found',
		]);
		expect(tool!.tickets).toMatchObject({
			read: {branches: 2, commits: 1, prs: null},
			prsSkipped: 'gh pr list failed: HTTP 404: Not Found',
		});
		expect(web!.tickets.prsSkipped).toBe('the repo has no origin');
		expect(web!.errors).toStrictEqual([]);
	});

	test('a gh that hangs is given up on, and one that is missing is not run', async () => {
		const fixture = workdirFixture();
		// `exec`, so the signal that ends gh ends the sleep, and nothing is
		// left holding gh's output open. It sleeps far past the timeout, and
		// the timeout leaves git room on a busy machine.
		writeExecutable(
			path.join(fixture.bin, 'gh'),
			'#!/bin/bash\nexec sleep 600\n',
		);
		const slow = await scanWorkdir(fixture.work, {
			env: fixture.env,
			commandTimeoutMs: 1000,
		});
		expect(slow.repos[0]!.errors).toStrictEqual([
			'gh pr list failed: timed out',
		]);
		expect(slow.repos[0]!.tickets).toMatchObject({
			read: {prs: null},
			prsSkipped: 'gh pr list failed: timed out',
		});
		// The branches still name the prefix.
		expect(slow.prefixes).toHaveProperty('B2B');

		// A PATH that holds git and nothing else. Dropping the stub from PATH
		// is not enough: some machines have a gh of their own in /usr/bin
		// (GitHub's runners do), and that one would be run.
		const gitOnly = path.join(fixture.root, 'git-only');
		writeExecutable(
			path.join(gitOnly, 'git'),
			`#!/bin/sh\nexec ${JSON.stringify(Bun.which('git'))} "$@"\n`,
		);
		const without = await scanWorkdir(fixture.work, {
			env: {...fixture.env, PATH: gitOnly},
		});
		expect(without.repos[0]!.tickets).toMatchObject({
			read: {branches: 5, prs: null},
			prsSkipped: 'gh is not installed',
		});
		expect(without.repos[0]!.errors).toStrictEqual([]);
		// The hanging stub was not run a second time, nor any other gh.
		expect(without.repos.map(repo => repo.tickets.prsSkipped)).toStrictEqual([
			'gh is not installed',
			'gh is not installed',
			'the repo has no origin',
		]);
	});

	test('what was skipped is counted by reason', async () => {
		const fixture = workdirFixture();
		const scan = await scanWorkdir(fixture.work, {env: fixture.env});
		expect(scan.skipped.counts).toStrictEqual({
			hidden: 1,
			nested: 1,
			worktree: 1,
			symlink: 1,
			bare: 1,
			node_modules: 1,
		});
		expect(scan.skipped.entries).toContainEqual({
			path: 'api-wt-PLAT-1',
			reason: 'worktree',
		});
	});

	test('two checkouts with one name are reported as a clash', async () => {
		const work = tempDir('lasagna-scan-');
		initRepo(path.join(work, 'a', 'api'));
		initRepo(path.join(work, 'b', 'api'));
		const scan = await scanWorkdir(work, {env: process.env});
		expect(scan.nameClashes).toStrictEqual([
			{
				name: 'api',
				paths: [path.join(work, 'a', 'api'), path.join(work, 'b', 'api')],
			},
		]);
		expect(formatScan(scan)).toContain('Name clash: 2 repos are named api');
	});
});

describe('lasagna scan', () => {
	function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
		const out: string[] = [];
		const err: string[] = [];
		const exit = runScanCommand(argv, {
			cwd,
			env,
			out: text => out.push(text),
			err: text => err.push(text),
		});
		return {exit, out, err};
	}

	test('prints the table and writes scan.json', async () => {
		const fixture = workdirFixture();
		const {exit, out, err} = run([fixture.work], fixture.root, fixture.env);
		expect(await exit).toBe(0);
		expect(err).toStrictEqual([]);
		const file = path.join(fixture.work, WORKDIR_SCAN_FILE);
		const written = JSON.parse(fs.readFileSync(file, 'utf8')) as ScanResult;
		expect(written.repos.map(repo => repo.name)).toStrictEqual([
			'api',
			'tool',
			'web',
		]);

		const table = out.join('\n');
		expect(table).toContain(`${fixture.work}: 3 repos (depth 2)`);
		expect(table).toMatch(
			/^api +main +TypeScript 43%, Markdown 29%, Python 14%, YAML 14% +\.pappardelle\.yml CLAUDE\.md README +PLAT 3, B2B 2, OPS 1$/m,
		);
		expect(table).toMatch(
			/^PLAT +4 +api +api 0\.75, web 0\.25 +api 0\.67, web 0\.33$/m,
		);
		expect(table).toMatch(
			/^Dropped, in no branch name and opening no PR title: SHA 2, /m,
		);
		expect(table).toContain(
			'Skipped: 1 hidden directory, 1 checkout inside another checkout, 1 worktree (.git is a file), 1 symlink, 1 bare repo, 1 node_modules',
		);
		expect(table).toContain('  group/tool: gh pr list failed: HTTP 404');
		expect(table).toContain(`Wrote ${file}`);
	});

	test('--dry-run writes nothing and --json prints the scan', async () => {
		const fixture = workdirFixture();
		const {exit, out} = run(
			[fixture.work, '--dry-run', '--json', '--depth', '1'],
			fixture.root,
			fixture.env,
		);
		expect(await exit).toBe(0);
		expect(fs.existsSync(path.join(fixture.work, '.lasagna'))).toBe(false);
		expect(out).toHaveLength(1);
		const scan = JSON.parse(out[0]!) as ScanResult;
		expect(scan).toMatchObject({version: 1, workdir: fixture.work, depth: 1});
		expect(scan.repos.map(repo => repo.name)).toStrictEqual(['api', 'web']);
	});

	test('with no directory it scans the work dir above, else where it stands', async () => {
		const fixture = workdirFixture();
		const api = path.join(fixture.work, 'api');
		const alone = run(['--dry-run', '--json'], api, fixture.env);
		expect(await alone.exit).toBe(0);
		expect(JSON.parse(alone.out[0]!)).toMatchObject({workdir: api});

		fs.mkdirSync(path.join(fixture.work, '.lasagna'));
		fs.writeFileSync(path.join(fixture.work, '.lasagna', 'workdir.yml'), '');
		const inWorkdir = run(['--dry-run', '--json'], api, fixture.env);
		expect(await inWorkdir.exit).toBe(0);
		expect(JSON.parse(inWorkdir.out[0]!)).toMatchObject({
			workdir: fixture.work,
		});
	});

	test('a bad flag or directory is refused before anything is scanned', async () => {
		const fixture = workdirFixture();
		for (const argv of [
			['--depth', 'two'],
			['--depth', '-1'],
			['--yaml'],
			['a', 'b'],
		]) {
			const {exit, out, err} = run(argv, fixture.work, fixture.env);
			expect(await exit, argv.join(' ')).toBe(2);
			expect(out).toStrictEqual([]);
			expect(err.join('\n')).toContain('Usage: lasagna scan');
		}

		const missing = run(['nowhere'], fixture.work, fixture.env);
		expect(await missing.exit).toBe(1);
		expect(missing.err.join('\n')).toContain('nowhere is not a directory');
		expect(fixture.ghCalls()).toStrictEqual([]);

		const help = run(['--help'], fixture.work, fixture.env);
		expect(await help.exit).toBe(0);
		expect(help.out.join('\n')).toContain('lasagna scan [dir]');
	});
});
