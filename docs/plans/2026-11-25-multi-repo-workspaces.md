# Multi-repo workspaces

Status: plan, not started. Written 2026-11-25, revised the same day after review.

## Naming

Lasagna is a superset of Pappardelle with its own name and its own state, so the two run side by side. The rename is [#17](https://github.com/vaibhavkaul/lasagna/pull/17), and this stack sits on it:

- **Lasagna's own names:** the command `lasagna`, state and worktrees under `~/.lasagna`, the tmux socket `lasagna_inner` and sessions `lasagna-*`, and `LASAGNA_*` in the environment.
- **Pappardelle's, unchanged:** its commands, its behaviour and its config formats. A repo keeps only `.pappardelle.yml` and `.pappardelle.local.yml`, and the home config is still called `.pappardelle.yml` (in `~/.lasagna`).
- **Lasagna-only settings** live in one file, `<workdir>/.lasagna/workdir.yml`.

The work dir was a "workspace" when this plan was first written. Its file, flag and variable are `workdir.yml`, `--workdir` and `LASAGNA_WORKDIR`; the prose below still says "workspace" for it in places.

## Goal

Run Lasagna on a **work dir** instead of one repo. For example, `~/code/com.github.taptapsend` holds 25 repos and their worktrees. One rail shows the spaces of every repo in the work dir.

A ticket that spans repos gets one lead agent that sees all of its repos. Getting started should take one command: Lasagna finds the repos, learns their defaults (Jira project, setup commands, PR rules) from their history, docs and Jira, and writes a config you approve.

## Decisions

| Decision                             | Choice                                                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What Lasagna runs on                 | The work dir. One TUI, one rail, all its repos.                                                                                                                                                                                               |
| A ticket in one repo                 | A **plain space**, as today. The agent runs in the repo's worktree and loads that repo's `CLAUDE.md`, skills and hooks.                                                                                                                       |
| A ticket in several repos            | A **ticket space** with one **lead agent**. It runs in a ticket folder that holds each repo's worktree as a real directory, so it sees the whole change.                                                                                      |
| How a ticket gets its repos          | Suggested from the ticket prefix when you create the space, and you confirm. Repos can be added later: by key, by `lasagna space add-repo`, or by the agent through MCP. A plain space becomes a ticket space when its second repo is added.  |
| Worktrees                            | Always, for every repo (appian-server included). A plain space's worktree is at `~/.lasagna/worktrees/<repo>/<KEY>/` (Pappardelle keeps its own in `~/.worktrees`); a ticket space's are inside its ticket folder. There is no in-place mode. |
| Ticket folders                       | `~/.lasagna/worktrees/_tickets/<workdir>/<KEY>/`, holding `<repo>/` worktrees                                                                                                                                                                 |
| Root main space                      | The work dir gets a main space of its own, at the top of the rail. Its agent runs at the work dir root with its `CLAUDE.md` and `.claude/`, and the sous-chef lives there. Each repo's main space sits below it, collapsible.                 |
| Setup                                | A CLI command that runs `claude -p`, not a skill, so you can re-run it from a plain terminal.                                                                                                                                                 |
| Where learned config goes            | `<workdir>/.lasagna/workdir.yml`, untracked. Setup writes it only after you approve the changes.                                                                                                                                              |
| What a repo can declare about itself | `<repo>/.pappardelle.yml`, committed in that repo, as in Pappardelle. It beats anything setup infers. A repo gets no Lasagna file name.                                                                                                       |
| Phase order                          | A to F as listed below. Scan and setup come before the runtime and TUI work, and ticket spaces come last (G).                                                                                                                                 |

Without a `workdir.yml`, Lasagna keeps today's single-repo behaviour, so upstream's tests and setups keep working.

## What the code assumes today

From a sweep of `source/` (2026-11-25):

- **Repo state is cached once per process.** `config.ts` keeps `repoRootCache`, `mainRepoRootCache`, `gitCommonDirCache` and `cachedRepoName` at module level, all taken from the process cwd. `getRepoRoot`, `getRepoName` and `getMainRepoRoot` are called in 10 files:

  | File                                                       | Calls  |
  | ---------------------------------------------------------- | ------ |
  | `cli.tsx`                                                  | 11     |
  | `config.ts`                                                | 11     |
  | `app.tsx`                                                  | 7      |
  | `tmux.ts`                                                  | 5      |
  | `supervise-runtime.ts`                                     | 5      |
  | `close-space.ts`                                           | 3      |
  | `repo-bootstrap.ts`                                        | 2      |
  | `skill-completion.ts`, `mcp-server.ts`, `close-command.ts` | 1 each |

- **Providers are process singletons.** `providers/index.ts` holds one issue tracker and one VCS host, plus one store each for state colours, PR link stamps and issue titles. `repo-bootstrap.ts` sets them up for the cwd repo.
- **Credentials go into the process env.** `bootstrapRepo` loads the repo's `.envrc` into `process.env`, filling only variables that aren't already set. With two repos in one process, the first repo's keys would silently apply to both.
- **`idow` merges config on its own.** It resolves the home, project and local config paths, then merges them with `yq` (`merge_config_layers`). That duplicates the TypeScript merge in `buildConfigFromLayers`.
- **Already per repo:**
  - State DAOs (`stateDaosByRepo(repo)`).
  - Most tmux helpers, which take `repoName ?? getRepoName()`.
  - Space identity and tmux session names, which include the repo.
  - The inner tmux server and the status daemon, which already serve every repo.
- **The outer session** is named `lasagna-<repo>` (`outerSessionName` in `tmux.ts`).
- **New branches are named after the issue key exactly:** `create-worktree.sh` runs `git worktree add -b "$ISSUE_KEY"`.

The work dir itself (2026-11-25):

- 25 repos, all directly under the work dir. There are no nested checkouts.
- Hand-made worktrees sit either beside their repo as `<repo>-<branch>` or under `<repo>-worktrees/<branch>/`. Branches look like `B2B-3127__biz-remittance-credit-frontend`.
- The work dir has its own `CLAUDE.md` and `.claude/`, and it isn't a git repo.

## Design

### 1. Config layers

From lowest priority to highest:

```
~/.lasagna/.pappardelle.yml           home
<workdir>/.lasagna/workdir.yml        NEW: the work dir; per-repo sections apply to that repo only
<repo>/.pappardelle.yml               what the repo declares, as in Pappardelle
<repo>/.pappardelle.local.yml         local, as in Pappardelle
```

A repo keeps only Pappardelle's two file names. There is no `.lasagna.yml`: what only Lasagna has is set in `workdir.yml`.

- **Finding the workspace:** the nearest `.lasagna/workdir.yml` at or above the repo's **main checkout**, or the dir in `LASAGNA_WORKDIR` (empty turns it off). Not from the cwd: a space's worktree lives under `~/.lasagna/worktrees`, outside the work dir. The TUI's `--workdir <dir>` flag comes with E.
- **Per-repo sections.** `workdir.yml` has top-level settings for every repo, plus a `repos.<name>` section for each repo. When resolving config for repo X, the order is: home, then workspace top level, then `repos.X` in `workdir.yml`, then the repo's file, then its local file.
- **Inferred values live apart from yours.** Setup writes `repos.<name>.inferred`, with a source and a confidence on each value. Your own edits go beside it and win. Re-running setup rewrites only `inferred`, so your edits survive.
- **One merge implementation.** `idow` stops merging with `yq` and asks the binary for the merged config instead (`lasagna state merged-config --project-root … --main-root …`). It already calls `pappardelle_state check-config` the same way.
- **Repo names must be unique in a workspace,** because state stays keyed by repo name (`~/.lasagna/repos/<name>/`). Scan detects clashes, and `workdir.yml` can give a repo an alias. That's cheaper than re-keying every store.

### 2. `scan`: deterministic facts, no Claude

`lasagna scan [dir]`:

- **Finding checkouts.** It looks at directories up to depth 2 (a flag) whose `.git` is a directory. It skips worktrees (where `.git` is a file), bare repos and nested checkouts.
- **For each repo it collects:** the remote URL, the default branch (`origin/HEAD`), the main languages (from `git ls-files` extensions), and whether it has a `.pappardelle.yml`.
- **Ticket evidence.** It counts keys matching `[A-Z][A-Z0-9]+-\d+`, noting where each was found:
  - branch names, local and remote
  - commit subjects from the last 180 days
  - PR titles, bodies and head branches (`gh pr list --state all --limit 200`, when `gh` is logged in for that host)

  Prefixes that only show up in commit text, like `UTF-8` or `SHA-256`, are dropped unless a branch or PR also has them.

- **Output:** `<workdir>/.lasagna/scan.json` plus a table on stdout. Repos are scanned in parallel, 4 at a time, and each `gh` call has a timeout. Anything missing, like `gh` or a remote, is reported and skipped, never fatal.
- **The result** is a weighted map from ticket prefix to repos, for example `PLAT → appian-server 0.62, appian-frontend 0.21, …`.

### 3. `setup`: learn, propose, approve

`lasagna setup [dir]` runs scan first, then adds what only reading the repos can tell.

- **Tool check first.** One short `claude -p` call reports which tools it has: Atlassian/Jira tools, `acli`, or neither. Setup prints the sources it will use. claude.ai connectors only exist when Claude runs under your login (an API key turns them off), so this is checked, not assumed.
- **One `claude -p` per repo,** 4 at a time:
  - It starts from a scratch dir with `--add-dir <repo>`, never from inside the repo. A headless Claude started inside a repo runs that repo's `.claude` hooks without asking.
  - It gets read-only tools only: Read, Grep and Glob, plus Jira read tools when present.
  - Its input is scan's facts for the repo, and it's asked to answer in JSON only.
- **What each repo's run works out:**
  - **Jira projects.** Scan's prefixes, confirmed against Jira. The best evidence is Jira's development panel, where PRs and branches linked to recent issues name this repo. Project names and components come next. Without Jira tools, it falls back to `acli` or REST with `JIRA_API_TOKEN`, and then to scan alone.
  - **Issue type conventions,** such as "B2B uses Sub-task" from `CLAUDE.md`.
  - **Setup commands for a new worktree** (`yarn podInstall`, `mise trust`, copying `.env`), taken from `CLAUDE.md`, `AGENTS.md` and the README.
  - **PR rules:** where the PR template is and the title format.
  - **The agent profile to use,** if the docs say.

  Every value carries a `source` (a file and line, a Jira query, or a scan count) and a `confidence` of high, medium or low.

- **Aggregate.** Build the prefix-to-repos map for the whole workspace, with a default repo for each prefix.
- **Approve.** Show a diff against the current `workdir.yml`. You can accept everything, accept repo by repo, or open it in `$EDITOR`. Nothing is written until you approve.
- **Flags:**
  - `--repo <name>` re-learns one repo.
  - `--no-claude` writes defaults from scan alone.
  - `--yes` accepts high-confidence values only.

### 4. Per-repo runtime (no UI change)

Make "which repo" a parameter instead of a property of the process.

- **Config:** replace the cwd-derived caches with `repoContext(root)`, a memoized record of the repo's root, main root, name and merged config. Callers that have a space pass its repo. Only the CLI entry point, and single-repo mode, still go by the cwd.
- **Providers:** maps keyed by repo instead of singletons (`issueTrackerFor(repo)`, `vcsHostFor(repo)`, and so on). `bootstrapRepo(repo)` can be called once for each repo.
- **Credentials:** a repo's `.envrc` values go into an env object for that repo. That object is passed to the repo's providers and to `idow` and agent spawns (`buildSpawnEnv` already builds the env for each spawn). Nothing is written into `process.env` any more.
- **CLI and MCP verbs** (`space`, `supervise`, `close`, `mcp`) accept `repo:KEY`. A bare key still works when only one repo has it, and gives an error listing the matches when several do.
- **The popup child process** calls `bootstrapRepo` for the repo of the space it opens for.

In single-repo mode nothing changes. That's the test for this phase: the existing suite passes untouched.

### 5. Workspace TUI

- **Outer session:** `lasagna-wd-<workdir>`. In single-repo mode it stays `lasagna-<repo>`, as today.
- **The rail lists spaces from every repo in `workdir.yml`,** reading each repo's registry through its DAOs. The status daemon already sends status for every repo.
- **The root main space** is the top row. Its agent runs at the work dir root. Its state lives in a store for the workspace itself (see "State for spaces that aren't in one repo" below).
- **Each repo's main space** comes below it, one row per repo and collapsible, so every repo's `main` checkout is still reachable.
- **Grouping:** by repo, which is the default, or by ticket. `rail-groups.ts` groups by workflow state today, and repo and ticket become two more groupings, switched by a key.
- **Each row** shows a short repo tag when the rail spans more than one repo. A ticket space shows the tags of all its repos.

### 6. Creating a space in one repo

- **The new-space prompt** gets a repo field, prefilled like this:
  - For an issue key: the prefix map's default repo. If the prefix spans several repos, it shows a pick list of the top choices. Choosing more than one creates a ticket space (section 7).
  - For free text: the last repo you used, which one key changes.
- **`idow` runs with `cwd` set to that repo's root** and with the repo's spawn env. Everything after that already works per repo.

### 7. Ticket spaces

A ticket space is a ticket with two or more repos and one lead agent.

- **Layout on disk:**

  ```
  ~/.lasagna/worktrees/_tickets/<workdir>/B2B-123/
    appian-server/     git worktree of appian-server, branch B2B-123
    tts-business/      git worktree of tts-business, branch B2B-123
    CLAUDE.md          generated
    .claude/           generated settings for the lead agent
  ```

  The worktrees are real directories, made with `git worktree add` (or moved there with `git worktree move`), not symlinks. The test below is why.

- **What the lead agent sees** (tested 2026-11-25, table below): Grep and Glob search every repo without being told a path. Each repo's `CLAUDE.md` and `.claude/skills` load when the agent first reads a file in that repo, as Claude Code loads nested `CLAUDE.md` files.
- **The generated `CLAUDE.md`** says it is a ticket folder, lists the repos with their default branch and PR rules, and repeats the work dir's rules. It doesn't `@`-import the work dir's `CLAUDE.md`: an import from outside the folder is skipped when Claude runs headless, and asks for approval otherwise. It is regenerated whenever a repo is added.
- **Repo settings don't load.** Only the `.claude/settings.json` of the folder Claude starts in applies, so the repos' env, permissions and hooks don't reach the lead agent. G generates the ticket folder's `.claude/settings.json`: the permissions of every repo merged, and the Lasagna hooks. Repo hooks and env stay out until a repo needs them.
- **Each repo keeps its own PR.** The branch and PR are per repo, and the rail row lists each repo's PR. `link_pr` takes a repo.
- **Companion pane:** one companion per repo worktree, using the existing companion splits. By default that's one gitui per repo.
- **Adding a repo** to a ticket space creates its worktree inside the ticket folder (with that repo's setup commands), regenerates `CLAUDE.md` and the settings, and tells the lead agent. It can be done from a key on the rail, from `lasagna space add-repo <KEY> <repo>`, or by the agent through an MCP tool.
- **A plain space becomes a ticket space** when its second repo is added. Its agent's conversation can't move with it, because Claude Code resumes conversations per directory, so the lead agent starts a new conversation in the ticket folder. Its first prompt carries a handoff: the issue, the plain agent's last few turns (`lasagna read`), and the branch's diff so far. The plain agent's session ends after the handoff, and then its worktree moves into the ticket folder with `git worktree move`. Moving it earlier would pull the directory out from under a running agent. The space's identity records the new worktree path.
- **Closing** a ticket space runs each repo's `pre_workspace_deinit` hooks. The worktrees stay on disk, as they do today, so the ticket folder stays too, minus the generated files.

#### Why real directories: the symlink test

Run 2026-11-25 with headless Claude Code in a folder holding two small repos. Each repo had a marker in a `.ts` file, a rule in its `CLAUDE.md`, a skill, and an env var in `.claude/settings.json`. The tool results were read from the stream log, not from the agent's own summary.

| Lead agent's folder                | Grep/Glob, no path                      | Grep, explicit path | Repo `CLAUDE.md`                                           | Repo skills         | Repo settings |
| ---------------------------------- | --------------------------------------- | ------------------- | ---------------------------------------------------------- | ------------------- | ------------- |
| Symlink per repo                   | none found (also Glob `alpha/src/*.ts`) | –                   | `@` imports skipped                                        | no                  | no            |
| `@` imports by real path           | none found                              | found               | imports skipped                                            | no                  | no            |
| `--add-dir` per repo               | only the start folder                   | found               | only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` | yes                 | no            |
| Real directories inside the folder | both repos found                        | found               | loads on first read in the repo                            | loads on first read | no            |

- ripgrep itself doesn't follow symlinks (`rg` finds nothing without `-L`), and Claude Code's Grep and Glob behave the same way.
- `CLAUDE.md` doesn't load at all when Claude runs under `/private/tmp`, so a test of what loads has to run from a folder in the home dir.

### State for spaces that aren't in one repo

The root main space and ticket spaces don't belong to a single repo, but every store is keyed by repo name. They use a workspace pseudo-repo, `@<workdir>`, in the same per-repo stores (`~/.lasagna/repos/@<workdir>/`). Its registry lists the root main space and the ticket spaces, and records each ticket's repos.

`@` can't start a git repo name that scan would accept, so the pseudo-repo can't collide with a real repo. Tmux session names would encode it like any other repo name (`tmuxSessionRepo`), but D must check that encoding first.

### Later

- **Adopt existing worktrees,** so the rail starts with your current work. That means matching your actual layout, `<repo>-<branch>` beside the repo and `<repo>-worktrees/<branch>/`, against a key prefix in the branch name (`B2B-3127__slug` → `B2B-3127`).
- **The rename to `lasagna`** was planned for after this stack. It came first instead, as #17 (see Naming), and with no migration: Lasagna starts with its own state and leaves Pappardelle's where it is.

## Phases and PRs

The PRs are stacked. Each one is green on its own, and single-repo behaviour is untouched until phase E.

| PR  | Contents                                                                                                                                            | Effort (my time)                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A   | Workspace and repo config layers in the TypeScript loader and its validation; `state merged-config`; `idow` reads the merged config from the binary | 1.5–2 h                                                   |
| B   | `scan`: discovery, facts, ticket evidence, `scan.json`, the prefix map                                                                              | 1.5–2 h                                                   |
| C   | `setup`: tool check, one `claude -p` per repo, aggregation, diff and approve, writing `inferred`                                                    | 2–3 h                                                     |
| D   | Per-repo runtime: `repoContext`, provider maps, env per repo, `repo:KEY` in the CLI and MCP, popup bootstrap, the `@<workdir>` pseudo-repo          | 3–4 h. The widest change: `app.tsx`, `tmux.ts`, `cli.tsx` |
| E   | Workspace TUI: outer session, rail across repos, root main space, grouping by repo and by ticket                                                    | 2–3 h                                                     |
| F   | Repo picker for one-repo spaces                                                                                                                     | 1–1.5 h                                                   |
| G   | Ticket spaces: ticket folder and generated `CLAUDE.md`, lead agent, per-repo PRs and companions, add-repo (key, CLI, MCP), plain-to-ticket handoff  | 3–4 h                                                     |

These ranges cover writing the code and getting CI green. They don't cover fixing upstream's ~3,700 tests where they assume one repo, which is the main unknown for D.

## Testing

- **A:** unit tests for layer order, per-repo sections, and the split between `inferred` and your edits. Plus an `idow` shell test that its merged config matches the TypeScript merge.
- **B:** a fixture work dir built in the test's temp dir. It has two repos, one worktree, one nested checkout and one bare repo, with branches and commits that contain real keys and noise like `UTF-8`. `gh` is stubbed on PATH, as the existing shell tests do.
- **C:** a fake `claude` on PATH that returns canned JSON. Tests cover each tool-check outcome, a repo whose run fails, and a re-run with your edits already present.
- **D:** the existing suite unchanged. Plus two-repo tests for the provider maps, env isolation (two `.envrc` files with different keys) and `repo:KEY` resolution.
- **E–F:** TUI tests in the existing style (`frame-input`, `rail-groups`), with a two-repo fixture and the root main space.
- **G:**
  - The ticket folder layout, with real worktrees, the generated `CLAUDE.md` and the generated settings.
  - Adding a repo through the CLI and through MCP.
  - The plain-to-ticket handoff prompt.
  - Moving a plain space's worktree into the ticket folder after the handoff, and the identity following it.
  - Closing, which runs each repo's deinit hooks and leaves the worktrees.
- **By hand:**
  1. Run `scan` and `setup` on `~/code/com.github.taptapsend`, and check the prefix map against what you know (PLAT, B2B, PAYM).
  2. Open the workspace rail.
  3. Turn a B2B ticket into a ticket space across appian-server and tts-business.

## Risks and open questions

- **Merge conflicts with upstream.** D and E change `app.tsx` (3.1k lines) and `tmux.ts` (4.5k lines). New logic goes in new modules, and edits to those two files stay at call sites.
- **Cost of setup.** About 25 `claude -p` runs. Each run is limited to the files it needs, and `--repo` exists for re-runs. Measure it on the real work dir in C.
- **Noise in ticket keys.** Commit text has false keys. Requiring a branch or PR match, plus the Jira check, should catch most of them. Check against the real work dir.
- **Repo hooks and env for the lead agent.** Settled for search, `CLAUDE.md` and skills (section 7). Still open: whether a repo's own hooks or env vars matter enough to merge them into the ticket folder's settings.
- **Branch names (open).** New branches are named after the key exactly (`B2B-123`), but your branches look like `B2B-123__slug`. Should Lasagna add a slug, either from the issue title or one you type?
- **The word "workspace" (settled).** The code already says "workspace" for a single space ("Workspace STE-5 is ready", `workspace_aware_agents`), and this plan uses it for the work dir. The work dir is a **workdir** in names: `workdir.yml`, `--workdir`, `LASAGNA_WORKDIR`.
