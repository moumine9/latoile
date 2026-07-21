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
