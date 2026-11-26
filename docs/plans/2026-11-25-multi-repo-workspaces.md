# Multi-repo workspaces

Status: plan, not started. Written 2026-11-25.

## Goal

Run Lasagna on a **work dir** (for example `~/code/com.github.taptapsend`, which holds ~30 repos and their worktrees) instead of on one repo. One rail shows the spaces of every repo in it. Getting there should take one command: Lasagna finds the repos, learns their defaults (Jira project, setup commands, PR rules) from their history, their docs and Jira, and writes a config you approve.

## Decisions

| Decision                            | Choice                                                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit Lasagna runs on                | The work dir. One TUI, one rail, all its repos.                                                                                                                       |
| A ticket that touches several repos | One space per repo, grouped under the ticket on the rail. Space identity is already (repo, key), so `B2B-123` in two repos is two spaces with distinct tmux sessions. |
| Worktrees                           | Everywhere, as today. No in-place mode.                                                                                                                               |
| Setup                               | A CLI command that runs `claude -p`, not a skill. Repeatable from a plain terminal.                                                                                   |
| Where learned config goes           | `<workdir>/.lasagna/workspace.yml`, untracked, written by setup after you approve it.                                                                                 |
| What a repo can declare itself      | `<repo>/.lasagna.yml`, committed in that repo. Beats anything inferred.                                                                                               |

Without a workspace file, Lasagna keeps today's single-repo behaviour, so upstream's tests and setups keep working.

## What the code assumes today

From a sweep of `source/` (2026-11-25):

- **Config caches one repo per process.** `config.ts` keeps `repoRootCache`, `mainRepoRootCache`, `gitCommonDirCache` and `cachedRepoName` at module level, all from the process cwd. `getRepoRoot` / `getRepoName` / `getMainRepoRoot` are called in 10 files: `cli.tsx` 11, `config.ts` 8, `app.tsx` 7, `tmux.ts` 5, `supervise-runtime.ts` 5, `close-space.ts` 3, `repo-bootstrap.ts` 2, and one each in `skill-completion.ts`, `mcp-server.ts` and `close-command.ts`.
- **Providers are process singletons.** `providers/index.ts` holds one issue tracker, one VCS host, and one each of state colours, PR link stamps and issue titles. `repo-bootstrap.ts` sets them for the cwd repo.
- **Credentials go into the process env.** `bootstrapRepo` loads the repo's `.envrc` into `process.env` (Linear keys and similar). Two repos in one process would overwrite each other.
- **`idow` merges config itself.** It resolves home, project and local paths, then merges them with `yq` (`merge_config_layers`), a second copy of the TypeScript merge in `buildConfigFromLayers`.
- **Already per repo, and ready to use:** state DAOs (`stateDaosByRepo(repo)`); most tmux helpers take `repoName ?? getRepoName()`; space identity and tmux session names include the repo; the inner tmux server and the status daemon already serve every repo.
- **Outer session** is `pappardelle-<repo>`.

## Design

### 1. Config layers

Lowest priority first:

```
~/.lasagna/.pappardelle.yml       home (path unchanged until the rename)
<workdir>/.lasagna/workspace.yml      NEW: workspace; per-repo sections apply to that repo only
<repo>/.lasagna.yml                   NEW: what the repo declares (falls back to .pappardelle.yml)
<repo>/.lasagna.local.yml             local (falls back to .pappardelle.local.yml)
```

- **Finding the workspace:** the nearest `.lasagna/workspace.yml` at or above the cwd, or `--workspace <dir>`.
- `workspace.yml` has a top-level section for every repo and a `repos.<name>` section for each repo. When resolving config for repo X, the merge is: home → workspace top level → `workspace.repos.X` → repo → local.
- **Inferred values live apart from yours.** Setup writes `repos.<name>.inferred`, with a source and confidence on each value. Your edits go next to it and win. Re-running setup rewrites only `inferred`, so your edits survive.
- **One merge implementation.** `idow` stops merging with `yq` and asks the binary instead (`lasagna state merged-config --project-root … --main-root …`). It already shells out to `pappardelle_state check-config`, so this is the same pattern.
- **Repo names must be unique in a workspace**, because state stays keyed by repo name (`~/.lasagna/repos/<name>/`). Scan detects clashes, and `workspace.yml` can give a repo an alias. That's cheaper than re-keying every store.

### 2. `scan`: deterministic facts, no Claude

`lasagna scan [dir]` (becomes `lasagna scan` with the rename):

- **Finds checkouts:** directories up to depth 2 whose `.git` is a directory. It skips worktrees (`.git` is a file), bare repos and nested checkouts.
- **For each repo it collects:** remote URL, default branch (`origin/HEAD`), main languages (from `git ls-files` extensions), and any `.lasagna.yml` / `.pappardelle.yml` present.
- **Ticket evidence:** keys matching `[A-Z][A-Z0-9]+-\d+` in:
  - branch names, local and remote
  - commit subjects from the last 180 days
  - PR titles, bodies and head branches (`gh pr list --state all --limit 200`, when `gh` is logged in for that host)

  Each key is counted with its source. Prefixes that only appear in commit text, like `UTF-8` or `SHA-256`, are dropped unless a branch or PR also has them.

- **Output:** `<workdir>/.lasagna/scan.json` plus a table on stdout. Repos run in parallel (4 at a time), with a timeout on each `gh` call. Anything missing, like `gh` or a remote, is reported and skipped, never fatal.
- **The result** is a weighted map from ticket prefix to repos, for example `PLAT → appian-server 0.62, appian-frontend 0.21, …`.

### 3. `setup`: learn, propose, approve

`lasagna setup [dir]` runs scan, then adds what only reading can tell.

- **Tool check first.** One short `claude -p` call reports which tools it has: Atlassian/Jira tools, `acli`, or neither. Setup prints the sources it will use. claude.ai connectors only exist when Claude runs under your login (an API key turns them off), so this is checked, not assumed.
- **One `claude -p` per repo,** 4 at a time:
  - Started from a scratch dir with `--add-dir <repo>`, never from inside the repo, because a headless Claude started in a repo runs that repo's `.claude` hooks without asking.
  - Read-only tools: Read, Grep and Glob, plus Jira read tools when present.
  - Input: scan's facts for the repo. Asked for JSON only.
- **What each repo run works out:**
  - The Jira project or projects: scan's prefixes, confirmed against Jira. Best evidence is the Jira development panel (the PRs and branches linked to recent issues name this repo). Next best is project names and components. Without Jira tools it falls back to `acli` / REST with `JIRA_API_TOKEN`, then to scan alone.
  - Issue type conventions, e.g. "B2B uses Sub-task" from `CLAUDE.md`.
  - Setup commands for a new worktree (`yarn podInstall`, `mise trust`, copy `.env`), taken from `CLAUDE.md`, `AGENTS.md` and the README.
  - PR rules: template location and title format.
  - The agent profile to use, if the docs say.

  Every value carries `source` (file and line, Jira query, or scan count) and a `confidence` of high, medium or low.

- **Aggregate.** Build the prefix → repos map for the whole workspace and a default repo per prefix.
- **Approve.** Show a diff against the current `workspace.yml`. You can accept all, accept per repo, or open it in `$EDITOR`. Nothing is written until you approve.
- **Flags:**
  - `--repo <name>` re-learns one repo.
  - `--no-claude` writes scan-only defaults.
  - `--yes` accepts high-confidence values only.

### 4. Per-repo runtime (no UI change)

Make "which repo" a parameter instead of a property of the process.

- **Config:** replace the cwd-derived caches with `repoContext(root)`, a memoized record of root, main root, name and merged config. Callers that have a space pass its repo. Only the CLI entry point (and single-repo mode) still uses the cwd.
- **Providers:** maps keyed by repo instead of singletons (`issueTrackerFor(repo)`, `vcsHostFor(repo)`, and so on). `bootstrapRepo(repo)` becomes callable once per repo.
- **Credentials:** `.envrc` values go into an env object for that repo, passed to its providers and to `idow`/agent spawns (`buildSpawnEnv` already builds per-spawn env). They no longer go into `process.env`.
- **CLI and MCP verbs** (`space`, `supervise`, `close`, `mcp`) accept `repo:KEY`. A bare key still works when only one repo has it, and gives an error listing the matches when several do.
- **The popup child process** calls `bootstrapRepo` for the repo of the space it opens for.

In single-repo mode, behaviour doesn't change. That's the test for this phase: the existing suite passes untouched.

### 5. Workspace TUI

- **Outer session** is `pappardelle-ws-<workspace>`; in single-repo mode, `pappardelle-<repo>` as today.
- **The rail lists spaces from every repo in `workspace.yml`.** It reads each repo's registry through its DAOs. The status daemon already sends every repo's status.
- **Grouping:** by repo (the default), or by ticket so the spaces of a cross-repo ticket sit together. `rail-groups.ts` groups by workflow state today; repo and ticket become two more ways to group, switched by a key.
- **Each row** shows a short repo tag when the rail spans more than one repo.
- **Main rows:** one per repo, collapsible, so the `main` checkout of each repo is still reachable.

### 6. Creating a space

- **The new-space prompt** gets a repo field, prefilled like this:
  - Issue key: the prefix map's default repo. A prefix that spans repos shows a pick list with the top choices, and choosing several creates one space per repo.
  - Free text: the last repo you used, changeable with one key.
- **`idow` runs with `cwd` = that repo's root** and the repo's spawn env. Everything after that already works per repo.

### Later

- **Adopt existing worktrees:** treat `*-wt-*` directories and branches named like `PLAT-1234-…` as spaces, so the rail starts with your current work.
- **Rename `pappardelle` → `lasagna`:** the binary, `~/.lasagna`, tmux sockets and session prefixes. This is its own PR, with a migration that moves the state directory and keeps the old socket readable.

## Phases and PRs

Stacked. Each PR is green on its own, and single-repo behaviour is untouched until phase E.

| PR  | Contents                                                                                                                                        | Effort (my time)                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A   | Workspace and repo config layers in the TypeScript loader and validation; `state merged-config`; `idow` reads the merged config from the binary | 1.5–2 h                                                   |
| B   | `scan`: discovery, facts, ticket evidence, `scan.json`, the prefix map                                                                          | 1.5–2 h                                                   |
| C   | `setup`: tool probe, one `claude -p` per repo, aggregation, diff/approve, writing `inferred`                                                    | 2–3 h                                                     |
| D   | Per-repo runtime: `repoContext`, provider maps, env per repo, `repo:KEY` in the CLI/MCP, popup bootstrap                                        | 3–4 h. The widest change: `app.tsx`, `tmux.ts`, `cli.tsx` |
| E   | Workspace TUI: outer session, rail across repos, grouping by repo and by ticket                                                                 | 2–3 h                                                     |
| F   | Repo picker and cross-repo ticket creation                                                                                                      | 1.5 h                                                     |

The ranges cover writing and green CI. They don't cover how long upstream's ~3,700 tests take to fix where they assume one repo; that is the main unknown for D.

## Testing

- **A:** unit tests for layer order, per-repo sections, fallback to the `.lasagna.*` names, the `inferred` vs user split, and an `idow` shell test that the merged config matches the TypeScript merge.
- **B:** fixture work dir built in the test's temp dir (two repos, one worktree, one nested checkout, one bare repo, branches and commits with keys and noise like `UTF-8`). `gh` is stubbed on PATH, as the existing shell tests do.
- **C:** a fake `claude` on PATH that returns canned JSON. Tests cover the tool-probe outcomes, a repo whose run fails, and re-running with user edits present.
- **D:** the existing suite unchanged, plus two-repo tests for the provider maps, env isolation (two `.envrc` files with different keys) and `repo:KEY` resolution.
- **E–F:** TUI tests in the existing style (`frame-input`, `rail-groups`), with a two-repo fixture.
- **By hand:** run `scan` and `setup` on `~/code/com.github.taptapsend`, check the prefix map against what you know (PLAT, B2B, PAYM), then open the workspace rail.

## Risks and open questions

- **Merge conflicts with upstream:** D and E change `app.tsx` (3.1k lines) and `tmux.ts` (4.5k). Keep new logic in new modules, and keep edits to those two files to call sites.
- **Cost of setup:** ~30 `claude -p` runs. Each run is capped to the files it needs, and `--repo` exists for re-runs. Measure on the real work dir in C.
- **Noise in ticket keys:** commit text has false keys. The branch/PR requirement and the Jira check should catch most of them; check against the real work dir.
- **Depth:** some work dirs nest repos deeper than 2 levels (`org/repo`). Depth is a flag; is 2 the right default?
- **Home config path:** stays `~/.lasagna/` until the rename PR. Decide whether the rename comes before or after this work. Doing it after keeps this stack smaller.
