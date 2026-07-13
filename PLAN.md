# Plan — GitLab correlation and remaining work

Updated: 2026-07-09.

## Direction (long term)

laToile should be *alive*: a persistent, ever-growing knowledge graph that remembers every ticket/MR/commit it has ever seen and can be queried across tickets — not just a per-request visualization. Target architecture:

- **Fetch cache (done)**: SQLite behind the `CacheStore` interface — speed only, short TTL, no graph semantics.
- **Knowledge graph (next)**: a Neo4j-backed persistence layer. Every traversal upserts its nodes/edges (with timestamps) into the graph, so coverage accumulates over time. Enables Cypher queries like "what connects PV2-17818 to PV2-16002" or "all issues whose MRs touched file X". Full design in [PLAN-NEO4J.md](PLAN-NEO4J.md) (GraphSink hook in `pipeline.ts`, data model, MCP query tools, phased rollout).
- **Query surface (done)**: the MCP server. Future tools should query the knowledge graph directly (fast, offline) and fall back to live traversal on cache miss.

## Session 2026-07-09

- **SQLite fetch cache** (`src/cache/`): `node:sqlite`-based, `~/.latoile/cache.db`, TTL `LATOILE_CACHE_TTL_MIN` (default 15 min), disable with `LATOILE_CACHE=off`, bypass per-request with `?refresh=1` / `refresh` option. Wrappers around `IssueSource`/`GitlabSource`; traversal untouched. Null Jira results not cached. Node ≥ 22.13 required (engines updated).
- **MCP server** (`src/mcp/server.ts`, bin `latoile-mcp`): stdio transport, tool `get_context(jiraKey, maxDepth?, maxNodes?, refresh?)` returning the LLM context payload. Verified with a JSON-RPC handshake smoke test. Register: `claude mcp add latoile -- node <repo>/dist/src/mcp/server.js`.
- 36 tests pass (`test/cache.test.ts` covers TTL expiry, hit/miss, refresh semantics, null non-caching, MCP handler).
- **Sibling clique fix**: sibling edges were emitted in both directions for every pair of children of a shared parent (PV2-17903: 834 of 902 edges were siblings). Now emitted once per pair (sorted) and only when the shared parent is not a graph node. PV2-17903 is down to 31 edges.
- **Defaults tightened**: `maxDepth` 2 → 1, `maxNodes` 100 → 50 (config, traversal, README, MCP schema).
- **Idea (user)**: support a GitLab MR URL as entry point — resolve MR, extract the Jira key from title/branch, run the normal traversal.
- **Search UX**: 8 results ordered by update, match highlighting, ↑/↓/Enter/Escape keyboard nav, click/Enter loads directly, recent lookups (localStorage) on empty-field focus.
- **Viz**: edge colors by type, neighborhood fade on tap, degree-based Jira node sizing, legend shows per-type node counts and hides absent types.
- **Graph slimming**: branch and commit nodes removed — folded into the MR node (`sourceBranch`, `commitCount`, `commits[]` with URLs) and shown in the details panel; `has_branch`/`has_commit` dropped from `EDGE_SCHEMA`. PV2-17892: 41→12 nodes.
- **Prefs persisted** (localStorage): theme, depth, nodes; stale 2/100 fallbacks in HTML/JS fixed to 1/50.

## Session 2026-07-13

- **Partial incremental refresh (phase 3a tier 2)**: `src/sink/kg-clients.ts` decorates the traversal's `IssueSource`/`GitlabSource` — issues whose stored `last_seen` is within `maxAgeSeconds` are reconstructed from Neo4j (`storedIssue`/`storedGitlabContext`, incl. MRs, commits, authors, projects), only the stale frontier hits Jira/GitLab. `hasGitlabData` now persisted on `:Issue` so graph-served issues skip GitLab searches. Graph-served issues get `provenance: 'knowledge_graph'` and are filtered out of sink ingestion (`last_seen` = last verified live, never self-refreshing). `get_context` reports `source: 'partial'` + `graphServedIssues`.

## Session 2026-07-10

- **Person identity re-schema** (user-reported dupes: kvervilleparis/"Karianne Verville-Paris", jsroy/jroy): `:Person` merges on a canonical key — first-name initials (one per hyphenated part) + last name (`src/sink/person-identity.ts`, `PERSON_SCHEMA_VERSION` migration drops old-keyed nodes). Properties: `name`, `jiraName`, `gitlabUsername`. Verified live post-migration (schemaVersion 2 nodes only).
- **Incremental refresh (phase 3a, first step)**: `get_context(maxAgeSeconds)` serves from `KnowledgeGraph.storedContext` when the stalest resolved issue in the stored neighborhood is fresh enough; result carries `source: 'live' | 'knowledge_graph'` + `ageSeconds`. Strongly-typed read layer (StoredContextResult, PersonActivityResult, GraphStatsResult…). Verified live: PV2-17892 answered from the graph in ~1s vs minutes live.
- **MCP server lifecycle**: the process now exits when the client disconnects — stdin EOF triggers a shutdown that first drains in-flight tool calls, then closes the Neo4j read handle and sink (their sockets otherwise keep the process alive).
- **ESLint added** (`yarn lint`): flat config, latest JS + typescript-eslint recommended, `no-explicit-any` as error. `typescript` pinned to 5.9 — typescript-eslint cannot parse with the TS 7 native preview.
- **Cross-repo fingerprint (user request)**: work items span 2–3 repos (microservices + microfrontends), so a fix attempt must consider every repo the original fix touched. MRs now carry `projectId`; context payloads (live + stored) expose `repositories` per work item and per context; the knowledge graph gains `:Project {path, gitlabId}` nodes with `IN_PROJECT` edges; new MCP tool `project_activity(projectPath, sinceDays?)` answers "what else changed in this repo".
- **Maintainability pass**: `src/mcp/` split into `server.ts` (wiring/lifecycle) + `handlers.ts` + `lifecycle.ts` + `tool-result.ts` with re-exports keeping the API stable; progress-notification closure deduped into `progressReporter`. Review findings fixed: shutdown settles 100ms before draining (requests read just before EOF reach their handlers), `storedContext` honors depth 0 (entry only) and `maxNodes` (entry always kept). `yarn smoke` (`scripts/smoke-mcp.mjs`) is a committed end-to-end check: handshake, tools/list, optional tool call, exit-on-EOF.

- **Neo4j phase 1 (ingest)**: `GraphSink` interface + `Neo4jSink` (batched MERGE upserts, first_seen/last_seen, constraints, siblings skipped, unresolved placeholders persisted with `resolved: false`), fire-safe pipeline hook, `LATOILE_NEO4J_*` config, docker-compose (container `latoile-neo4j`, image neo4j:2026.05.0, data at `D:\DockerVolumes\neo4j`), `test/sink.test.ts` with fake Cypher runner. Phase 2 (MCP query tools) next — see PLAN-NEO4J.md.

- **MR entry point** (`src/collector/mr-entry.ts`, `buildContextGraphFromMr` in pipeline, MCP tool `get_context_from_mr`): a GitLab MR URL resolves to its Jira key (source branch → title → description) and runs the normal traversal; result includes a `resolved_from` block. Verified live: Prescription!6606 → PV2-17818 (source branch). UI: pasting an MR link in the entry field resolves it via `GET /api/resolve-mr` and loads the graph (verified in browser).
- **MCP server extended** (`src/mcp/server.ts`): three tools — `get_context`, `search_issues` (JQL search extracted to `src/collector/search.ts`, shared with `/api/search`), `get_issue` (single fetch, cache-backed, no traversal). All tools return `structuredContent` + output schemas; pipeline logs stream as MCP logging notifications and as progress notifications when the client sends a `progressToken`. Verified over real stdio: 158 progress notifications on a PV2-17892 run. Tests in `test/mcp.test.ts` (43 total pass).

# Previous session (2026-07-08)

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
