# Plan — GitLab correlation and remaining work

Session date: 2026-07-08. Written so work can resume after the usage limit resets.

## Done in this session

- **Fixed the empty graph for PV2-17830.** `acli jira workitem view` no longer accepts `--key`; the key is positional. Also, the default field set omits `issuelinks`, `subtasks`, `parent`, and `comment`, so the client now requests `--fields '*all'` (`src/collector/acli.ts`, `viewArgs`). Verified: the CLI now returns the full parent chain for PV2-17830.
- **Dark theme applied** to `public/styles.css`, `public/index.html` (Quicksand font), and the Cytoscape colors in `src/web/app.ts`. Dark only, per request. Palette mapping: jira = info `#27b7ec`, entry = warning `#ffa726`, MR = error.light `#f46a66`, branch = primary `#93a9c1`, commit = success `#c4e49e`, doc = primary.light `#e5eaef`.
- **Zoom** in the graph canvas: explicit Cytoscape zoom options (min 0.1, max 5, wheelSensitivity 0.2) plus +/−/fit buttons bottom-right.
- **CLAUDE.md** created; yarn is the default tooling.
- **GitLab HTTP client** (`src/collector/gitlab-http.ts`):
  - Replaces spawning `glab` processes with direct `fetch()` calls using the PAT read from glab's local config file (`%LOCALAPPDATA%\glab-cli\config.yml` on Windows, `~/.config/glab-cli/config.yml` on Unix). No credentials in the repo.
  - Token can also be overridden via `LATOILE_GITLAB_TOKEN` env var.
  - `LATOILE_GITLAB_GROUPS=13205630,76319214` (numeric IDs for `familiprix/priorx` and `familiprix/developpement/priorx`).
  - `LATOILE_GITLAB_ACTIVE_DAYS=90`: projects inactive for longer are skipped in group scans.
  - `LATOILE_GITLAB_CONCURRENCY=20`: up to 20 concurrent requests (safe with fetch keep-alive vs the old 8-process limit).
  - Per-request time: ~0.3–0.5 s (was ~6.5 s per `glab` spawn).
  - **Verified**: PV2-17818 → 4 MRs, 4 branches, 29 commits in ~45 s (bottleneck is now `acli` Jira fetches, not GitLab).
  - `.env` file in project root (gitignored) loads automatically on startup via `src/config.ts`.
- **Jira dev-status hint** (`src/collector/acli.ts`): `customfield_10000` is parsed to determine `hasGitlabData: boolean | undefined`. When `false` (Jira confirms 0 repos/branches/PRs/commits), the traversal skips the glab call entirely — no wasted CLI invocations.
- **Edge strength** (`src/types.ts`, `src/collector/traversal.ts`, `src/model/graph.ts`): `Relation` and `GraphEdge` now carry `strength: 'strong' | 'weak'`. Structural Jira links (parent, subtask, sibling, link) are `strong`; text mentions are `weak`. Consumers (UI, LLM payload) can filter or style accordingly.
- **Edge schema** (`src/model/graph.ts`): `EDGE_SCHEMA` (exported) declares the valid source/target node type for each edge type — living documentation + runtime-testable contract.
- All 22 tests pass (`yarn test`).

## Test notes

- PV2-17830 currently has commits but no MR, so don't use it alone to validate MR rendering. PV2-17818 has MR `familiprix/priorx/Prescription!6606`.
- Set `LATOILE_GITLAB_GROUPS=familiprix/priorx` to enable automatic project enumeration, or `LATOILE_GITLAB_PROJECTS=familiprix/priorx/Prescription,...` for explicit control.

## Also pending

- README still shows npm commands and old behavior; update after manual validation of MR rendering.
- UI: surface `strength` as edge style (dashed for weak/mention edges).
- Jira fetch speed: each `acli` call takes ~5 s (binary spawn overhead). A direct Jira HTTP client (opt-in via `LATOILE_JIRA_TOKEN` + `LATOILE_JIRA_EMAIL`, similar to `GitlabHttpClient`) would bring the full pipeline from ~45 s to ~5–10 s.
