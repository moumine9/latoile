# PLAN-ORBIT — adopting GitLab Orbit alongside latoile

## Context

GitLab Orbit (beta, GitLab 19.1) is GitLab's official "knowledge graph of the SDLC,"
exposed to AI agents over MCP — the same shape latoile has been hand-rolling. It ships
in two flavors:

- **Orbit Local** — the `orbit` CLI parses a *local* checkout, extracts definitions and
  cross-file references, and writes a **code graph to `~/.orbit/graph.duckdb`**. Runs as a
  stdio MCP server exposing three tools: `run_sql` (read-only DuckDB SQL), `get_graph_schema`,
  `index`. Tables: `gl_file`, `gl_directory`, `gl_definition`, `gl_imported_symbol`,
  `gl_edge`, `_orbit_manifest`. Free, all tiers, no GitLab credits. **Code only — no Jira,
  no MRs/pipelines.**
- **Orbit Remote** — managed GitLab.com service; CDC → ClickHouse; indexes the full SDLC
  (merge requests, pipelines, work items, users, security findings) + code across a group.
  Queried via REST API, MCP tools, Duo Agent Platform.

**Why this matters for latoile.** Two things Orbit does *not* do keep latoile relevant:
it never touches **Jira** (our whole reason for existing — the Jira↔GitLab bridge), and
Orbit Local only sees **local checkouts**. But Orbit fills a real gap latoile has: our
matching *never scans source-file contents* (a key cited only in code is invisible to us),
and we have no code-structure knowledge at all. Orbit Local is exactly a code-structure
index. **The relationship is complementary, not competitive** — latoile answers "which
issues / MRs / repos relate to this Jira key," Orbit answers "where is this symbol defined
and what references it."

Goal of this plan: capture the value quickly with near-zero risk, then decide whether to
invest in tighter integration. Do **not** rip out Neo4j or the Jira bridge — Orbit
supplements them.

## Phase 0 — Co-run Orbit Local's MCP server (zero code, do first)

Let an agent that already uses latoile's MCP also have the code graph. No latoile changes.

1. Install (already have `glab`; on Windows):
   ```powershell
   glab orbit local --install       # or: irm https://gitlab.com/gitlab-org/orbit/knowledge-graph/-/raw/main/install.ps1 | iex
   ```
2. Index the repos we actually work in (local checkouts we already have, e.g.
   `c:\repos\prescription\frontend`, `c:\repos\prescription\backend`):
   ```powershell
   glab orbit local index c:\repos\prescription\backend
   glab orbit local index c:\repos\prescription\frontend
   ```
3. Register the MCP server next to latoile's, e.g. in `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "latoile":      { "command": "latoile-mcp" },
       "orbit-local":  { "command": "orbit", "args": ["mcp", "serve"] }
     }
   }
   ```

**Outcome / exit check:** in a real task, feed a Jira key to latoile to get the repos/MRs,
then ask Orbit `run_sql`/`get_graph_schema` code-structure questions about those repos.
If the combination measurably shortens "understand the existing code for this ticket,"
Phase 1 is justified. If not, stop here — Phase 0 alone is already useful.

### Phase 0 — done (2026-07-21)

- Installed Orbit Local **v0.91.0** to `C:\Users\amoumine\AppData\Local\Programs\orbit\orbit.exe`
  (user PATH updated — needs a fresh terminal to resolve `orbit`).
- Indexed the **`prescription` monorepo** — 5,670 files, 123,891 definitions, 278,012
  relationships in ~13s. Graph at `~/.orbit/graph.duckdb`.
- Registered both servers in project `.mcp.json` (`latoile` via `node dist/src/mcp/server.js`,
  `orbit-local` via `orbit mcp serve` exposing `run_sql` / `get_graph_schema` / `index`).
- Validated the value: a single `run_sql` for `%QuickBatchRenew%` returned the whole feature
  across repos — frontend `useQuickBatchRenew` (`hooks/useQuickBatchRenew.tsx:86`, the exact
  file `PLAN_IMPROVMENTS.md` flagged as invisible to latoile) plus backend `QuickBatchRenewal`
  class/request/tests and the frontend actions. This is the source-content layer latoile lacks.

### Multi-repo handling (2026-07-21)

Work items span many repos, so the whole local repo set is indexed into the one shared
graph (`~/.orbit/graph.duckdb`), each scoped by `(repo_path, branch, commit_sha)` — cross-repo
"where does symbol X live across services" queries then work in one SQL.

- **Canonical tree: `D:\repos`.** The machine has a near-duplicate mirror under `C:\repos`;
  only `D:\repos` is indexed. Indexing both would double-count shared repos (Orbit's
  `project_id` is a synthetic hash, not GitLab's id, so duplicates aren't deduped).
- **`scripts/orbit-reindex.ps1`** bulk-indexes every git repo under a root **sequentially**
  (the graph is single-writer). `-Clean` wipes the graph first for a from-scratch rebuild —
  use it to refresh and drop stale branch entries rather than let them accumulate.
- Current state: 26 repos under `D:\repos` (+ `D:\latoile`) = **~31k files, ~357k definitions,
  ~807k relationships**, indexed in ~35s. Refresh with
  `pwsh -File scripts/orbit-reindex.ps1 -Root D:\repos -Clean` after pulling.
- **Correlation key for Phase 1:** because `project_id` is synthetic, join latoile's GitLab
  `repositories` (e.g. `familiprix/priorx/Prescription`) to Orbit by the **last path segment,
  lowercased** (`prescription`), matched against `_orbit_manifest.repo_path` / `gl_file.path`.

**Gotchas discovered (feed into Phase 1):**
- `orbit index` needs a **git repo root** and silently no-ops (exit 0, empty output) on a
  non-repo dir. `prescription/backend` and `prescription/frontend` are **not** repo roots — the
  git root is the `prescription` monorepo. Index the repo root, not the sub-app.
- The DuckDB graph is **single-writer**: running `orbit index` concurrently with another
  `orbit` read (e.g. `schema`) silently drops the write. Serialize indexing.
- Auto-generated files blow the per-file CPU budget (77 EF Core `*.Designer.cs` migrations
  skipped, 0 errored) — expected and harmless; they aren't useful code anyway.
- Verified schema for Phase 1's join: `gl_file.path` ↔ `gl_definition.file_path`
  (`name`, `fqn`, `definition_type`, `start_line`/`end_line`); `gl_edge`
  (`source_id`/`source_kind`, `relationship_kind`, `target_id`/`target_kind`) for references.

## Phase 1 — latoile emits a "code neighborhood" per issue (optional, if Phase 0 proves out)

Close latoile's source-content blind spot by joining what we already know (MR **changed
files**) to Orbit's definitions/edges. latoile already has an opt-in
`fetchChangedFiles` producing `changedFiles: string[]` per MR (`gitlab-http.ts`,
`LATOILE_GITLAB_FETCH_FILES`). Orbit's `gl_file` → `gl_definition` → `gl_edge` turns those
paths into "the symbols this fix touched and what references them."

Sketch:
- New optional collector (behind a flag, e.g. `LATOILE_ORBIT=1`) that opens
  `~/.orbit/graph.duckdb` read-only (Node has `node:sqlite` but not DuckDB; use the DuckDB
  Node addon, or shell out to `orbit`/`glab orbit local` — prefer shelling out to stay
  consistent with the acli/glab pattern and avoid a native dep).
- For each resolved issue's `changedFiles`, query definitions in those files and their
  inbound references, capped, and attach as a `code` block on the context item
  (new optional field on `ContextItem` — mirror the discipline we used for `traversal`).
- Strictly additive and flag-gated: unset flag or missing graph → field simply absent.

**Hard constraint to design around:** Orbit indexes **local checkouts only**, and it
indexes the **default branch**, while latoile's MRs reference feature branches. So this
enrichment is best-effort ("definitions as they exist on the indexed branch") and only
works for repos the user has cloned and indexed. Surface a clear "not indexed" signal
rather than a silent empty (same lesson as the GitLab-degraded case).

## Phase 2 — Evaluate Orbit Remote to replace the MR-search fan-out (spike, gated)

Our recent 429 pain is a direct consequence of latoile brute-force searching MRs across
*every* project per Jira key (O(issues × projects)). Orbit Remote is a **pre-built index of
exactly that data** (merge requests, work items, code) queryable via REST/MCP. If Remote is
enabled for our instance, latoile could ask Orbit "MRs referencing key X" instead of
fanning out — potentially eliminating the rate-limit problem at its root and speeding up
the pipeline.

This is the most strategically interesting option and the biggest bet:
- **Gated on availability** — Remote is a managed GitLab.com service; confirm it's on for
  our group/tier and what the query surface actually returns before designing anything.
- Still **no Jira** — Remote indexes GitLab *work items*, not Jira issues, so latoile's
  `acli` traversal and key-correlation stay.
- Scope of a spike: one query against Orbit Remote for a known key (e.g. PV2-17843), compare
  its MR results to what `gitlab-http.ts` returns today. If parity, prototype a
  `GitlabSource` implementation backed by Orbit Remote behind a flag, keeping the current
  HTTP client as fallback.

## Phase 1 — done (2026-07-22)

Implemented as an opt-in, additive enrichment:

- `src/collector/orbit.ts` — `OrbitClient` shells out to `orbit sql -F json` (process-spawn,
  no DuckDB native dep). `resolveRepo(name)` matches a GitLab repo path's last segment,
  lowercased, against `_orbit_manifest` (cached, including negative results — repos aren't
  re-checked every issue). `definitionsForFiles(projectId, files, cap)` queries
  `gl_definition` for an MR's changed files. `project_id` is kept as a **string** end-to-end
  — Orbit's ids exceed `Number.MAX_SAFE_INTEGER` (e.g. `1218550793252928037`), so it's cast
  to `VARCHAR` in SQL and never parsed as a JS number.
- `codeNeighborhoodsForIssue` groups an issue's MR `changedFiles` by repo and produces one
  `ContextCodeNeighborhood` per repo — critically **branch-aware**: it carries the *indexed*
  `branch`/`commit_sha` (not the MR's branch) and distinguishes three states: repo
  not-indexed (`indexed: false`), indexed but the changed files don't resolve on that branch
  (`files_matched: 0` — the branch-drift tell), and matched (definitions present). This
  replaced an earlier design that only signaled indexed/not-indexed and would have silently
  presented branch-drifted code as authoritative — caught by an advisor review before coding.
- Wired into `buildContextGraph` (`src/pipeline.ts`) as a fire-safe step after `buildContext`;
  a code-enrichment failure never fails the run. New `ContextItem.code?` field
  (`src/types.ts`), populated only when `LATOILE_ORBIT=1` and the issue has MR
  `changedFiles` (i.e. `LATOILE_GITLAB_FETCH_FILES=1` is also on).
- New config: `LATOILE_ORBIT` (off by default), `LATOILE_ORBIT_BIN` (default `orbit`),
  `LATOILE_ORBIT_DB` (override DuckDB path), `LATOILE_ORBIT_MAX_DEFS` (default 40).
- 7 unit tests (`test/orbit.test.ts`): repo-name derivation, manifest parsing incl. the
  BIGINT-as-string handling, negative-result caching, definition capping, SQL quote-escaping
  and a non-numeric-project-id guard, and the three-state neighborhood behavior.

**Verified live** against PV2-17843/PV2-17313/PV2-18006/PV2-9050: real definitions resolved
across `Prescription`, `portal`, and `notification-manager` with correct file/line info,
e.g. `QuickBatchRenewal.cs:18`, `IPortalNotificationClient.cs:8`,
`PortalNotificationClient.cs:13` — the exact code `PLAN_IMPROVMENTS.md` Point 1 flagged as
invisible to latoile is now surfaced, per-issue, across repos.

**Known limitation to watch:** `files_matched` was well below `files_changed` on some repos
in the live run (e.g. portal 2/4, notification-manager 1/2 or 3/4) — expected given branch
drift (each repo is indexed at whatever branch was checked out, not the MR's branch), but
worth periodically re-running `scripts/orbit-reindex.ps1 -Clean` against current `develop2`/
`main` to keep the match rate meaningful.

## Risks / non-goals

- **Beta.** Orbit is GitLab 19.1 beta; CLI, schema (`gl_*` tables), and MCP tool names may
  change. Pin behaviors behind flags; don't hard-depend.
- **No native dep creep.** latoile deliberately avoids native addons (`node:sqlite`, pure-JS
  neo4j-driver). Prefer shelling out to `orbit`/`glab` over the DuckDB Node addon.
- **Local-only + default-branch** for Orbit Local — not a remote code oracle.
- **Keep the Jira bridge and Neo4j.** Orbit supplements; it does not replace latoile's
  reason to exist.

## First concrete steps

1. Do **Phase 0** now (install, index the two prescription repos, add `orbit-local` to
   `.mcp.json`). Use it on the next real ticket; judge the value.
2. In parallel, **one read-only spike**: check whether **Orbit Remote** is enabled for our
   GitLab group and what a "MRs for key" query returns — that determines whether Phase 2 is
   even on the table.
3. Only if Phase 0 proves out: prototype **Phase 1**'s `changedFiles → definitions` join as a
   flag-gated, additive `code` block.

## Open questions

- Is Orbit **Remote** available for our instance/tier? (Decides Phase 2.)
- Does Orbit Local index anything other than the **default branch**? (Bounds Phase 1's usefulness.)
- Does Orbit capture any **code ↔ work-item** linkage we could reuse, or is that purely
  latoile's job? (Docs were not explicit.)
