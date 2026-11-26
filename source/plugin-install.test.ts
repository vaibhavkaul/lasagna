import {test, expect} from 'bun:test';
import {
	installPlugin,
	type PluginInstallDeps,
	type RunResult,
} from './plugin-install.ts';

const REPO = '/home/me/.lasagna/repo';
const SETTINGS = '/home/me/.claude/settings.json';
const CODEX_HOOKS = '/home/me/.codex/hooks.json';
const AGY = '/home/me/.gemini/config';
const AGY_LINK = `${AGY}/plugins/lasagna`;
const PLUGIN_DIR = `${REPO}/plugins/lasagna`;
const enoent = (command: string): RunResult => ({
	status: null,
	error: Object.assign(new Error(`spawn ${command} ENOENT`), {code: 'ENOENT'}),
});

const legacy = (script: string) => ({
	type: 'command',
	command: `python3 ~/.lasagna/hooks/${script}`,
});
const mine = {type: 'command', command: 'bd prime'};

function fakeDeps(
	options: {
		settings?: string;
		codexHooks?: string;
		agy?: boolean;
		respond?: (command: string, args: string[]) => RunResult | undefined;
		worktree?: boolean;
	} = {},
) {
	const calls: string[] = [];
	const files = new Map<string, string>();
	const links = new Map<string, string>();
	const dirs = new Set<string>(options.agy ? [AGY] : []);
	if (options.settings !== undefined) files.set(SETTINGS, options.settings);
	if (options.codexHooks !== undefined) {
		files.set(CODEX_HOOKS, options.codexHooks);
	}

	const printed: string[] = [];
	const deps: PluginInstallDeps = {
		repoDir: REPO,
		settingsPath: SETTINGS,
		codexHooksPath: CODEX_HOOKS,
		agyConfigDir: AGY,
		run(command, args, quiet) {
			calls.push([command, ...args, ...(quiet ? ['(quiet)'] : [])].join(' '));
			return options.respond?.(command, args) ?? {status: 0};
		},
		readFile: file => files.get(file),
		writeFile(file, content) {
			files.set(file, content);
		},
		exists: file => files.has(file) || links.has(file) || dirs.has(file),
		readLink: file => links.get(file),
		link(target, file) {
			links.set(file, target);
		},
		print(line) {
			printed.push(line);
		},
		isLinkedWorktree: () => options.worktree ?? false,
	};
	return {deps, calls, files, links, dirs, printed};
}

test('points the Claude Code and Codex marketplaces at the checkout, then installs the plugin', () => {
	const {deps, calls} = fakeDeps();
	expect(installPlugin(deps)).toBe(0);
	expect(calls).toStrictEqual([
		`claude plugin marketplace add ${REPO}`,
		'claude plugin install lasagna@lasagna-marketplace --scope user',
		'codex plugin marketplace remove lasagna-marketplace (quiet)',
		`codex plugin marketplace add ${REPO}`,
		'codex plugin add lasagna@lasagna-marketplace',
	]);
});

test('skips an agent whose CLI is missing, leaving its old hooks running', () => {
	const settings = JSON.stringify({hooks: {Stop: [{hooks: [legacy('x.py')]}]}});
	const {deps, calls, files, printed} = fakeDeps({
		settings,
		respond: command => (command === 'claude' ? enoent(command) : undefined),
	});
	expect(installPlugin(deps)).toBe(0);
	expect(printed[0]!.includes('not on PATH')).toBe(true);
	expect(files.get(SETTINGS)).toBe(settings);
	expect(calls.includes('codex plugin add lasagna@lasagna-marketplace')).toBe(
		true,
	);
});

test("a failed marketplace add skips that agent's install and hook cleanup but not the others", () => {
	const {deps, calls, files} = fakeDeps({
		settings: JSON.stringify({hooks: {Stop: [{hooks: [legacy('x.py')]}]}}),
		respond: (command, args) =>
			command === 'claude' && args[1] === 'marketplace'
				? {status: 1}
				: undefined,
	});
	expect(installPlugin(deps)).toBe(1);
	expect(calls.some(call => call.startsWith('claude plugin install'))).toBe(
		false,
	);
	expect(files.has(`${SETTINGS}.lasagna.bak`)).toBe(false);
	expect(calls.includes('codex plugin add lasagna@lasagna-marketplace')).toBe(
		true,
	);
});

test('a Codex marketplace that is not there to remove does not stop the install', () => {
	const {deps, calls} = fakeDeps({
		respond: (command, args) =>
			command === 'codex' && args[2] === 'remove' ? {status: 1} : undefined,
	});
	expect(installPlugin(deps)).toBe(0);
	expect(calls.includes('codex plugin add lasagna@lasagna-marketplace')).toBe(
		true,
	);
});

const sessionHook = (script: string) => ({
	type: 'command',
	command: `python3 ${script}`,
});
const CODEX_COMMAND = `python3 "${PLUGIN_DIR}/hooks/record-lasagna-session.py"`;
const codexSessionHooks = {
	SessionStart: [
		{
			matcher: 'startup|resume|clear',
			hooks: [{type: 'command', command: CODEX_COMMAND}],
		},
	],
	UserPromptSubmit: [{hooks: [{type: 'command', command: CODEX_COMMAND}]}],
};

test('adds the Codex session hook to hooks.json, pointing at the checkout', () => {
	const {deps, files, printed} = fakeDeps();
	expect(installPlugin(deps)).toBe(0);
	expect(JSON.parse(files.get(CODEX_HOOKS)!)).toStrictEqual({
		hooks: codexSessionHooks,
	});
	expect(files.has(`${CODEX_HOOKS}.lasagna.bak`)).toBe(false);
	expect(printed.some(line => line.includes('trust the session hook'))).toBe(
		true,
	);
});

test("replaces session hooks from older installs, keeping the user's hooks and a backup", () => {
	const original = JSON.stringify({
		hooks: {
			SessionStart: [
				{
					matcher: 'startup|resume|clear',
					hooks: [sessionHook('~/.lasagna/hooks/record-lasagna-session.py')],
				},
				{hooks: [mine]},
			],
			UserPromptSubmit: [
				{
					hooks: [
						sessionHook('"/old/checkout/hooks/record-lasagna-session.py"'),
					],
				},
			],
		},
	});
	const {deps, files, printed} = fakeDeps({codexHooks: original});
	expect(installPlugin(deps)).toBe(0);
	expect(JSON.parse(files.get(CODEX_HOOKS)!)).toStrictEqual({
		hooks: {
			SessionStart: [{hooks: [mine]}, ...codexSessionHooks.SessionStart],
			UserPromptSubmit: codexSessionHooks.UserPromptSubmit,
		},
	});
	expect(files.get(`${CODEX_HOOKS}.lasagna.bak`)).toBe(original);
	expect(printed.some(line => line.includes('review your other hooks'))).toBe(
		true,
	);
});

test('leaves a Codex hooks.json that already has the session hook untouched, so its trust holds', () => {
	const original = JSON.stringify({
		hooks: {...codexSessionHooks, Stop: [{hooks: [mine]}]},
	});
	const {deps, files, printed} = fakeDeps({codexHooks: original});
	expect(installPlugin(deps)).toBe(0);
	expect(files.get(CODEX_HOOKS)).toBe(original);
	expect(printed.some(line => line.includes('trust'))).toBe(false);
});

test('leaves an unparseable Codex hooks.json alone and says what to add', () => {
	const {deps, files, printed} = fakeDeps({codexHooks: '{'});
	expect(installPlugin(deps)).toBe(0);
	expect(files.get(CODEX_HOOKS)).toBe('{');
	expect(printed.some(line => line.includes(CODEX_COMMAND))).toBe(true);
});

test('links the plugin into agy in place', () => {
	const {deps, links} = fakeDeps({agy: true});
	expect(installPlugin(deps)).toBe(0);
	expect(links.get(AGY_LINK)).toBe(PLUGIN_DIR);
});

test('repoints an agy link left by another checkout', () => {
	const {deps, links} = fakeDeps({agy: true});
	links.set(AGY_LINK, '/old/checkout/plugins/lasagna');
	expect(installPlugin(deps)).toBe(0);
	expect(links.get(AGY_LINK)).toBe(PLUGIN_DIR);
});

test('removes the session hook install-agy-hooks.sh merged into agy hooks.json, keeping a backup', () => {
	const lint = {PostToolUse: [{type: 'command', command: 'lint.sh'}]};
	const original = JSON.stringify({
		'lasagna-session': {
			SessionStart: [
				{
					type: 'command',
					command: 'python3 ~/.lasagna/hooks/record-lasagna-session.py',
				},
			],
		},
		lint,
	});
	const {deps, files} = fakeDeps({agy: true});
	files.set(`${AGY}/hooks.json`, original);
	expect(installPlugin(deps)).toBe(0);
	expect(JSON.parse(files.get(`${AGY}/hooks.json`)!)).toStrictEqual({lint});
	expect(files.get(`${AGY}/hooks.json.lasagna.bak`)).toBe(original);
});

test('warns when agy has the plugin disabled', () => {
	const {deps, files, printed} = fakeDeps({agy: true});
	files.set(
		`${AGY}/config.json`,
		JSON.stringify({plugins: {lasagna: {enabled: false}}}),
	);
	expect(installPlugin(deps)).toBe(0);
	expect(printed.some(line => line.includes('agy plugin enable lasagna'))).toBe(
		true,
	);
});

test('skips agy until it has been set up', () => {
	const {deps, links, printed} = fakeDeps();
	expect(installPlugin(deps)).toBe(0);
	expect(links.size).toBe(0);
	expect(printed.some(line => line.includes('agy is not set up'))).toBe(true);
});

test('leaves a copy agy installed itself and fails with how to replace it', () => {
	const {deps, links, dirs, printed} = fakeDeps({agy: true});
	dirs.add(AGY_LINK);
	expect(installPlugin(deps)).toBe(1);
	expect(links.has(AGY_LINK)).toBe(false);
	expect(printed.some(line => line.includes('agy plugin uninstall'))).toBe(
		true,
	);
});

test('removes only the old Pappardelle hooks from settings, keeping a backup', () => {
	const original = JSON.stringify({
		model: 'opus',
		hooks: {
			PreCompact: [
				{matcher: 'auto', hooks: [legacy('update-status.py')]},
				{matcher: 'manual', hooks: [legacy('update-status.py'), mine]},
			],
			Stop: [{hooks: [legacy('update-status.py')]}],
			SessionStart: [{hooks: [mine]}],
		},
	});
	const {deps, files} = fakeDeps({settings: original});
	expect(installPlugin(deps)).toBe(0);
	expect(JSON.parse(files.get(SETTINGS)!)).toStrictEqual({
		model: 'opus',
		hooks: {
			PreCompact: [{matcher: 'manual', hooks: [mine]}],
			SessionStart: [{hooks: [mine]}],
		},
	});
	expect(files.get(`${SETTINGS}.lasagna.bak`)).toBe(original);
});

test('backs up settings as they were before claude rewrote them', () => {
	const original = JSON.stringify({hooks: {Stop: [{hooks: [legacy('x.py')]}]}});
	const {deps, files} = fakeDeps({settings: original});
	const {run} = deps;
	deps.run = (command, args) => {
		if (args[1] === 'marketplace') {
			const settings = JSON.parse(files.get(SETTINGS)!) as object;
			files.set(
				SETTINGS,
				JSON.stringify({...settings, extraKnownMarketplaces: {}}),
			);
		}

		return run(command, args);
	};

	expect(installPlugin(deps)).toBe(0);
	expect(files.get(`${SETTINGS}.lasagna.bak`)).toBe(original);
	expect(JSON.parse(files.get(SETTINGS)!)).toStrictEqual({
		extraKnownMarketplaces: {},
	});
});

test('drops the hooks key when only Pappardelle hooks were configured', () => {
	const {deps, files} = fakeDeps({
		settings: JSON.stringify({
			model: 'opus',
			hooks: {Stop: [{hooks: [legacy('update-status.py')]}]},
		}),
	});
	installPlugin(deps);
	expect(JSON.parse(files.get(SETTINGS)!)).toStrictEqual({model: 'opus'});
});

// Lasagna installs beside Pappardelle, whose entries sit in the same files.
test("leaves an installed Pappardelle's marketplace, plugin and hooks alone", () => {
	const pappardelle = '/home/me/.pappardelle';
	const settings = JSON.stringify({
		enabledPlugins: {'pappardelle@pappardelle-marketplace': true},
		hooks: {
			Stop: [
				{
					hooks: [
						{
							type: 'command',
							command: `python3 ${pappardelle}/hooks/update-status.py`,
						},
					],
				},
			],
		},
	});
	const theirSessionHook = sessionHook(
		`"${pappardelle}/repo/plugins/pappardelle/hooks/record-agent-session.py"`,
	);
	const codexHooks = {
		SessionStart: [
			{matcher: 'startup|resume|clear', hooks: [theirSessionHook]},
		],
		UserPromptSubmit: [{hooks: [theirSessionHook]}],
	};
	const agyHooks = JSON.stringify({
		'pappardelle-session': {SessionStart: [theirSessionHook]},
	});
	const {deps, calls, files, links} = fakeDeps({
		settings,
		codexHooks: JSON.stringify({hooks: codexHooks}),
		agy: true,
	});
	const theirAgyLink = `${AGY}/plugins/pappardelle`;
	links.set(theirAgyLink, `${pappardelle}/repo/plugins/pappardelle`);
	files.set(`${AGY}/hooks.json`, agyHooks);

	expect(installPlugin(deps)).toBe(0);

	expect(calls.filter(call => call.includes('pappardelle'))).toStrictEqual([]);
	expect(files.get(SETTINGS)).toBe(settings);
	expect(JSON.parse(files.get(CODEX_HOOKS)!)).toStrictEqual({
		hooks: {
			SessionStart: [
				...codexHooks.SessionStart,
				...codexSessionHooks.SessionStart,
			],
			UserPromptSubmit: [
				...codexHooks.UserPromptSubmit,
				...codexSessionHooks.UserPromptSubmit,
			],
		},
	});
	expect(files.get(`${AGY}/hooks.json`)).toBe(agyHooks);
	expect(links.get(theirAgyLink)).toBe(
		`${pappardelle}/repo/plugins/pappardelle`,
	);
	expect(links.get(AGY_LINK)).toBe(PLUGIN_DIR);
});

test('leaves settings without old hooks untouched', () => {
	const settings = JSON.stringify({hooks: {SessionStart: [{hooks: [mine]}]}});
	const {deps, files} = fakeDeps({settings});
	expect(installPlugin(deps)).toBe(0);
	expect(files.get(SETTINGS)).toBe(settings);
	expect(files.has(`${SETTINGS}.lasagna.bak`)).toBe(false);
});

test('keeps hook groups it does not recognise', () => {
	const {deps, files} = fakeDeps({
		settings: JSON.stringify({
			hooks: {Stop: [null, {hooks: [legacy('update-status.py')]}]},
		}),
	});
	expect(installPlugin(deps)).toBe(0);
	expect(JSON.parse(files.get(SETTINGS)!)).toStrictEqual({
		hooks: {Stop: [null]},
	});
});

test('leaves unparseable settings alone and still succeeds', () => {
	const {deps, files, printed} = fakeDeps({settings: '{not json'});
	expect(installPlugin(deps)).toBe(0);
	expect(files.get(SETTINGS)).toBe('{not json');
	expect(printed.some(line => line.includes('by hand'))).toBe(true);
});

test('warns that removing the worktree it installed from drops the plugin', () => {
	const fromWorktree = fakeDeps({worktree: true});
	installPlugin(fromWorktree.deps);
	expect(fromWorktree.printed.some(line => line.includes('git worktree'))).toBe(
		true,
	);

	const fromMain = fakeDeps();
	installPlugin(fromMain.deps);
	expect(fromMain.printed.some(line => line.includes('git worktree'))).toBe(
		false,
	);
});
