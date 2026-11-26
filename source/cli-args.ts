import meow from 'meow';
import {packageJsonUrl} from './runtime.ts';

const helpText = `
	Usage
	  $ lasagna [--profile <name>] [prompt]
	  $ lasagna --workdir <dir>
	  $ lasagna --resume <prompt or issue-key>
	  $ lasagna highlight <issue-key> [--focus]
	  $ lasagna send <issue-key> [text]
	  $ lasagna close <issue-key> [--yes]
	  $ lasagna send <issue-key> --keys <key>...
	  $ lasagna spaces [--json]
	  $ lasagna space get [issue-key] [--json] [--field <name>]...
	  $ lasagna space list [--json]
	  $ lasagna space add-repo [space] <repo>
	  $ lasagna agent-profile list [--json]
	  $ lasagna scan [dir] [--depth N] [--json] [--dry-run]
	  $ lasagna setup [dir] [--yes] [--dry-run] [--no-claude] [--repo <name>]...
	  $ lasagna read <issue-key> [--turns N] [--json]
	  $ lasagna companion <command...>
	  $ lasagna update [--restart-tuis | --no-restart-tuis]
	  $ lasagna restart [--hard [--yes]]
	  $ lasagna plugin install

	Description
	  Interactive TUI for managing lasagna workspaces.
	  Displays worktree spaces in an fzf-style list with agent and
	  companion panes for the selected space.

	  If a prompt is provided, creates a new session directly without
	  entering the interactive TUI.
	  Existing workspaces resume automatically when opened by issue key.

	  In a work dir (a directory with .lasagna/workdir.yml listing its repos)
	  a space of another repo is named repo:KEY, wherever an issue key goes.
	  A bare key is the repo the command runs in, or the one repo that has it.

	  Started at a work dir's root, or anywhere in it outside its configured
	  repos, or with --workdir <dir>, the TUI shows every repo of the work dir
	  on one rail: the work dir's own main space, each repo's main space, and
	  the spaces of all of them, grouped by repo (t groups by ticket, r folds
	  the repos' main spaces). Started in a configured repo it shows that repo.

	Commands
	  highlight <key>  Select a row in the running TUI by issue key. With
	                   --focus, also focus that space's agent pane
	  link-pr <url>    Record a verified PR/MR for the current workspace
	  send <key> [text]
	                   Submit text as a prompt to the space's agent session.
	                   Everything after the key is sent as is, flags
	                   included. Reads stdin when no text is given
	  close <key>      Close a space, same as x in the TUI
	  send <key> --keys <key>
	                   Press tmux key names (Escape, S-Tab, C-c) in the space's
	                   agent session, in order, without submitting anything.
	                   Repeat --keys for several
	  spaces           List open spaces with status, title, PR and branch
	                   summary (--json for the full record)
	  space get [key]  What a space is: its phase, title, worktree, branch,
	                   profile, tmux sessions and panes, PR and status. With
	                   no key, the space this runs in. See lasagna space --help
	  space list       The main space and every open space, as space get
	  space add-repo [space] <repo>
	                   Add a repo of the work dir to a space. A ticket space
	                   gains its worktree; a plain space becomes a ticket
	                   space. See lasagna space add-repo --help
	  agent-profile list
	                   The agent profiles a space can be opened on with
	                   --agent-profile (--json with the files defining each)
	  scan [dir]       Find the repos in a work dir and the ticket prefixes
	                   their branches, commits and PRs name; writes
	                   <dir>/.lasagna/scan.json. See lasagna scan --help
	  setup [dir]      Scan, then learn each repo's defaults with Claude and,
	                   once approved, write them to <dir>/.lasagna/workdir.yml.
	                   See lasagna setup --help
	  read <key>       Print the last turns of a space's conversation
	                   (--turns N, default 5; --json)
	  screen|state|wait|answer <key>
	                   Watch another space's agent and answer its prompts.
	                   See lasagna state --help
	  queue|schedule|schedules|unschedule
	                   Wake another space's agent later with an OS timer
	  tui panes|focus-log
	                   Diagnostics for the running TUIs' panes
	  companion        Run, type into, read, resize and close panes in a
	                   space's companion. See lasagna companion --help
	  mcp              Serve these commands as MCP tools over stdio. Agents
	                   start this
	  mcp install      Add that server to Codex, OpenCode, Antigravity and Pi.
	                   install.sh runs this
	  update           Update Lasagna to the latest release (same as U)
	  restart          Restart this repo's TUI in place
	  restart --hard   End every agent session, then restart every TUI
	  plugin install   Install the plugin (skills, hooks and MCP tools) from this
	                   install into Claude Code, Codex and agy. install.sh runs this

	Controls
	  j/k or arrows  Navigate between spaces
	  Enter          Focus the agent pane
	  s / Option+s   Jump to the sous-chef (main space's agent)
	  n              New space (create worktree + issue)
	  x / Del        Close space
	  o              Open workspace (apps, links, etc.)
	  d              Open IDE
	  /              Search spaces
	  U              Update Lasagna to the latest release
	  ?              All keys
	  q/Ctrl+C       Quit

	Options
	  --profile <name>    Use a configured profile instead of automatic selection
	  --agent-profile <name>
	                      Launch the space's agent on this agent profile, for
	                      this launch only. Not applied to an agent already
	                      running
	  --resume            Skip the initialization prompt when opening a space
	  --no-resume         Enable the initialization prompt for an existing space
	  --wait              After opening a space, wait up to 60s for its agent to
	                      start; exit 3 if it isn't confirmed
	  --no-layout         Don't set up tmux pane layout (run standalone)
	  --workspace         Outer workspace root when linking a nested repository
	  --restart-tuis      After update, restart running TUIs without asking
	  --no-restart-tuis   After update, leave running TUIs alone and print a hint
	  --yes               Skip the confirmation for close or restart --hard

	Examples
	  $ lasagna              # Run with tmux layout
	  $ lasagna --no-layout  # Run standalone (list only)
	  $ lasagna "fix auth bug"  # Create new session with prompt
	  $ lasagna --profile mobile "fix auth bug"  # Select the mobile profile
	  $ lasagna --resume STA-313  # Reopen without an initialization prompt
	  $ lasagna --agent-profile codex STA-313  # Open STA-313 on codex this time
	  $ lasagna --resume --wait STA-313  # Reopen, then wait for its agent
	  $ lasagna highlight STA-313  # Highlight row in running TUI
	  $ lasagna highlight main --focus  # Jump to the sous-chef's agent pane
	  $ lasagna send 313 "fix the failing tests"  # Prompt STA-313's agent
	  $ lasagna send 313 --keys Escape  # Interrupt STA-313's agent
	  $ lasagna close STA-313 --yes  # Close STA-313 without asking
	  $ lasagna companion hunk diff --watch  # Show a diff in this space's companion
	  $ lasagna update       # Update, then ask before restarting running TUIs
	  $ lasagna restart      # Restart this repo's TUI in place
	  $ lasagna restart --hard  # End agent sessions, restart every TUI
`;

export const SPACE_USAGE = `Usage: lasagna space get [issue-key] [--json] [--field <name>]...
       lasagna space list [--json]
       lasagna space add-repo [space] <repo>`;

export const SPACE_HELP = `
	Usage
	  $ lasagna space get [issue-key] [--json] [--field <name>]...
	  $ lasagna space list [--json]
	  $ lasagna space add-repo [space] <repo>

	space get prints what Lasagna knows about a space, from its stores:
	repo, key, phase (starting, open, closing or closed), title, worktreePath,
	branch, profile, agentSessions, tmux (socket, socketFlag, agentSession,
	companionSession, agentTarget, companionTarget), panes (agent, companion),
	prNumber, prLinks, pipeline, unresolvedCommentCount and status. With no
	key it answers for the space it runs in: LASAGNA_SPACE, else the
	worktree or main checkout that holds the working directory. In a work
	dir, repo:KEY names a space of another of its repos.

	space list prints the main space, then every open space in the rail's order.

	space add-repo adds a repo of the work dir to a space, which makes a plain
	space a ticket space: see lasagna space add-repo --help.

	Options
	  --json          Print the record as JSON
	  --field <name>  Print one field, such as profile or tmux.agentTarget: a
	                  string bare, an object as JSON, nothing for null. Repeat
	                  for several, printed as one JSON object keyed by name

	Exit codes
	  0  Printed
	  1  No such space, or not in a space and no key given
	  2  Usage
	  3  A state store could not be read. space list still prints the
	     spaces it could read and names each one it could not
`;

export const AGENT_PROFILE_USAGE = 'Usage: lasagna agent-profile list [--json]';

export const AGENT_PROFILE_HELP = `
	Usage
	  $ lasagna agent-profile list [--json]

	Lists the agent profiles a space can be opened on, one name per line: the
	built-in claude and every entry under agent_profiles: in the merged config.
	Pass one to lasagna --agent-profile <name> to open a space on it.

	Options
	  --json  Print [{name, sources}], sources being the config files that
	          define the profile, highest priority first ([] for the built-in
	          claude)

	Exit codes
	  0  Printed
	  2  Usage
	  3  The config could not be read
`;

export function parseCli(argv: readonly string[] = process.argv.slice(2)) {
	return meow(helpText, {
		importMeta: {...import.meta, url: packageJsonUrl},
		// `send` reads its key and text from raw argv (parseSendArgs).
		argv: argv[0] === 'send' ? ['send'] : [...argv],
		// `update` asks on a TTY only when neither --restart-tuis nor
		// --no-restart-tuis was passed, which meow's default of false would make
		// indistinguishable.
		booleanDefault: undefined,
		flags: {
			profile: {type: 'string'},
			agentProfile: {type: 'string'},
			resume: {type: 'boolean'},
			wait: {type: 'boolean'},
			workspace: {type: 'string'},
			workdir: {type: 'string'},
			layout: {
				type: 'boolean',
				default: true,
			},
			restartTuis: {
				type: 'boolean',
			},
			hard: {
				type: 'boolean',
			},
			yes: {
				type: 'boolean',
			},
			teardownOnly: {
				type: 'boolean',
			},
			focus: {
				type: 'boolean',
			},
			keys: {
				type: 'string',
				isMultiple: true,
			},
			json: {
				type: 'boolean',
			},
			turns: {
				type: 'number',
			},
		},
	});
}

const subcommands = {
	close: {
		usage: 'lasagna close <issue-key> [--yes]',
		// --teardown-only is internal: a self-close hands the session kill to a
		// detached copy of itself, because the kill ends the calling process.
		flags: ['--yes', '--teardown-only'],
		help: `
	Usage
	  $ lasagna close <issue-key> [--yes]

	Closes a space, same as x in the TUI: runs its pre_workspace_deinit
	hooks, ends its agent and companion sessions, and removes it from the
	list. The worktree stays on disk. A running TUI drops the row within
	10 seconds. On a terminal it asks first.

	Options
	  --yes  Skip the confirmation. Required when not run from a terminal
`,
	},
	restart: {
		usage: 'lasagna restart [--hard [--yes]]',
		flags: ['--hard', '--yes'],
		help: `
	Usage
	  $ lasagna restart [--hard [--yes]]

	Restarts this repo's TUI in its tmux pane on the build that ran this
	command, then waits for it to report ready. Your terminal stays attached,
	and agent and companion sessions keep running. Exits non-zero when the
	TUI is not confirmed on that build.

	Options
	  --hard  End every agent and companion session, then restart every TUI
	  --yes   Skip --hard's confirmation
`,
	},
	update: {
		usage: 'lasagna update [--restart-tuis | --no-restart-tuis]',
		flags: ['--restart-tuis', '--no-restart-tuis'],
		help: `
	Usage
	  $ lasagna update [--restart-tuis | --no-restart-tuis]

	Installs the latest release (same as U in the TUI). Running TUIs stay on
	the old build until they restart; on a terminal it asks first.

	Options
	  --restart-tuis      Restart running TUIs without asking. Exits non-zero
	                      when one is not confirmed running afterwards
	  --no-restart-tuis   Leave running TUIs alone and print a hint
`,
	},
	mcp: {
		usage: 'lasagna mcp [install]',
		flags: [],
		help: `
	Usage
	  $ lasagna mcp
	  $ lasagna mcp install

	mcp serves Lasagna's commands as MCP tools over stdio, for the session
	that started it. Agents start this, so you shouldn't need to. Outside a repo
	with a .pappardelle.yml it serves no tools.

	mcp install adds that server to each of Codex, OpenCode, Antigravity and Pi
	that is installed, and auto-approves its companion tools where the agent asks
	first. install.sh runs this. Claude Code gets both from the plugin.
`,
	},
	'plugin install': {
		usage: 'lasagna plugin install',
		flags: [],
		help: `
	Usage
	  $ lasagna plugin install

	Installs the Lasagna plugin (skills, hooks and MCP tools) from this
	install into Claude Code, Codex and agy, skipping any that isn't installed.
	  Claude Code: points lasagna-marketplace at the install; it loads the
	    plugin in place, so a new install takes effect after /reload-plugins.
	    Removes the hooks older installs merged into ~/.claude/settings.json.
	  Codex: installs the plugin's skills, and points the session hook in
	    ~/.codex/hooks.json at the install.
	  agy: links ~/.gemini/config/plugins/lasagna to the install.
	Files it changes are backed up to <file>.lasagna.bak first.
`,
	},
} as const;

// The prompt is read from raw argv because meow would pull anything
// flag-shaped out of it.
// Only --keys and --force right after the key are flags, so a prompt that
// mentions them later on is still sent as text.
export function parseSendArgs(argv: readonly string[]): {
	key?: string;
	text: string;
	keys: string[];
	force: boolean;
} {
	const [key, ...rest] = argv.slice(argv.indexOf('send') + 1);
	if (key === undefined || key.startsWith('-'))
		return {text: '', keys: [], force: false};
	const keys: string[] = [];
	let force = false;
	for (;;) {
		if (rest[0] === '--force') {
			rest.shift();
			force = true;
		} else if (rest[0] === '--keys' || rest[0]?.startsWith('--keys=')) {
			const flag = rest.shift()!;
			const value = flag === '--keys' ? rest.shift() : flag.slice(7);
			if (value) keys.push(value);
		} else {
			break;
		}
	}

	// A --force typed after the text is still the flag; text that really ends
	// in --force goes on stdin. One inside the text is text.
	const trailing = rest.length > 1 && rest.at(-1) === '--force';
	return {
		key,
		text: (trailing ? rest.slice(0, -1) : rest).join(' '),
		keys,
		force: force || trailing,
	};
}

export type SubcommandGate =
	| {action: 'run'}
	| {action: 'help'; text: string}
	| {action: 'reject'; message: string};

// `close`, `restart` and `update` act on live spaces or TUIs and `plugin
// install` rewrites Claude Code settings, so a flag they don't know must stop
// them. meow only answers --help when it is the sole argument and otherwise
// ignores unknown flags.
export function subcommandGate(argv: readonly string[]): SubcommandGate {
	// Any other `plugin ...` is a typo, not a prompt, and as a prompt it would
	// create a workspace.
	const name = argv[0] === 'plugin' ? 'plugin install' : argv[0];
	if (name === undefined || !Object.hasOwn(subcommands, name)) {
		return {action: 'run'};
	}

	const {usage, flags, help} = subcommands[name as keyof typeof subcommands];
	const given = argv.filter(arg => arg.startsWith('-'));
	if (given.some(arg => arg === '--help' || arg === '-h')) {
		return {action: 'help', text: help};
	}

	if (
		name === 'plugin install' &&
		argv.filter(arg => !arg.startsWith('-')).join(' ') !== 'plugin install'
	) {
		return {
			action: 'reject',
			message: `Unknown command lasagna ${argv.join(' ')}\nUsage: ${usage}`,
		};
	}

	if (
		name === 'mcp' &&
		!['mcp', 'mcp install'].includes(
			argv.filter(arg => !arg.startsWith('-')).join(' '),
		)
	) {
		return {
			action: 'reject',
			message: `Unknown command lasagna ${argv.join(' ')}\nUsage: ${usage}`,
		};
	}

	const unknown = given.find(
		arg => !(flags as readonly string[]).includes(arg),
	);
	if (unknown !== undefined) {
		return {
			action: 'reject',
			message: `Unknown flag ${unknown} for lasagna ${name}\nUsage: ${usage}\nRun lasagna ${name} --help for details`,
		};
	}

	if (given.includes('--restart-tuis') && given.includes('--no-restart-tuis')) {
		return {
			action: 'reject',
			message: `--restart-tuis and --no-restart-tuis can't be combined\nUsage: ${usage}`,
		};
	}

	return {action: 'run'};
}
