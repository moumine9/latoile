# Plan — latoile roadmap

Consolidated from the former `PLAN-NEO4J.md`, `PLAN-ORBIT.md`, `PLAN-LEARNING.md`, and
`PLAN_IMPROVMENTS.md` (2026-08-17). Sections are ordered by impact — the knowledge graph is
the core of what makes latoile more than a per-request Jira viewer, everything below builds
on it or feeds it.

## Direction (long term)

latoile should be *alive*: a persistent, ever-growing knowledge graph that remembers every
ticket/MR/commit it has ever seen and can be queried across tickets — not just a per-request
visualization.

- **Fetch cache** — SQLite behind `CacheStore`. Speed only, short TTL, no graph semantics. Done.
- **Knowledge graph** — Neo4j-backed persistence layer, accumulates across runs, queryable via
  Cypher/MCP. Done, see below.
- **Query surface** — the MCP server, backed by the knowledge graph where possible, falling back
  to live traversal. Done.

---

## 1. Knowledge graph (Neo4j persistence)

The foundation everything else builds on: every traversal upserts its nodes/edges into Neo4j
with `first_seen`/`last_seen`, so coverage accumulates instead of being thrown away per request.

**Done:**
- Data model: `:Issue`, `:MergeRequest`, `:Commit`, `:Person`, `:Project`, `:Doc`, `:File`
  (opt-in), relationships mirroring `EDGE_SCHEMA` plus what the viz graph drops (branches/commits
  folded into MRs for display, kept raw here). Sibling edges intentionally not persisted
  (derivable from shared parents).
- `src/sink/graph-sink.ts` (`GraphSink` interface) + `src/sink/neo4j-sink.ts` (batched Cypher
  MERGE upserts, uniqueness constraints, fire-safe pipeline hook — a sink failure never fails a
  run). Config: `LATOILE_NEO4J_URI`/`_USER`/`_PASSWORD`, `LATOILE_NEO4J=off` kill switch, lazy
  driver import so `yarn start` without config never loads `neo4j-driver`.
- Unresolved placeholder issues persisted (`resolved: false`) so the graph knows its own
  unexplored frontier.
- **Deleted/moved issue flagging**: `IssueNode.missing` set when a live fetch actively returns
  nothing (vs. an unfetched depth/cap placeholder, left `undefined`). Persisted as
  `:Issue.missing`; stored reads exclude `missing: true` issues so a confirmed-gone ticket always
  falls back to a live re-check instead of being served stale forever.
- **MR diff ingestion** (opt-in, `LATOILE_GITLAB_FETCH_FILES=1`): changed file paths persisted as
  `:File`/`TOUCHES`. Unlocks "issues whose MRs touched file X" — no query tool surfaces it yet.
- **Background watcher** (`src/watcher.ts`, `yarn watcher`): one-shot script (not a daemon,
  scheduled externally) that re-traverses the stalest known issues and logs status/title/assignee
  changes.
- **Person identity re-schema**: `:Person` merges on a canonical key (first-name initials +
  last name) to fix duplicate people from Jira-name vs GitLab-username mismatches
  (`PERSON_SCHEMA_VERSION` migration drops old-keyed nodes on schema change). v3/v4
  (2026-08-17): secondary labels `:JiraUser`/`:GitlabUser` record which systems a person is
  *observed* to have touched — Jira assignee and verified GitLab MR author respectively. Commit
  authorship does **not** grant `:GitlabUser`: GitLab's commits API returns a free-text author
  name, not a linked account, so authorship alone doesn't prove GitLab access.
- Local dev: `docker-compose.yml` (`latoile-neo4j`, `neo4j:2026.05.0`, data at
  `D:\DockerVolumes\neo4j`), browser UI at http://localhost:7474.

**Left to do:**
- Identity mapping is still per-source-value with a canonical-key heuristic, not a real
  cross-system mapping table. Accepted for now; revisit if false-merges/splits become a problem.
- `:File`/`TOUCHES` data is ingested but has no MCP query tool yet ("what else touched this
  file").

---

## 2. MCP query surface & incremental refresh

The layer that makes the knowledge graph actually useful to an agent instead of just a Cypher
sandbox.

**Done:**
- Four canned-Cypher MCP tools: `find_connection` (shortest path between two issues),
  `known_context` (offline stored neighborhood with freshness), `person_activity`,
  `project_activity`, `graph_stats`. No raw-Cypher tool by design (injection/foot-gun risk).
- **Incremental refresh, two tiers.** Tier 1: when the whole stored neighborhood is fresh enough,
  `get_context(maxAgeSeconds)` answers straight from the graph with zero live calls
  (`source: 'knowledge_graph'`). Tier 2: otherwise the traversal runs with knowledge-graph-backed
  client decorators (`src/sink/kg-clients.ts`) — each issue within budget is reconstructed from
  the graph, only the stale frontier hits Jira/GitLab (`source: 'partial'`, `graphServedIssues`
  count). Graph-served issues carry `provenance: 'knowledge_graph'` and are excluded from
  re-ingestion, so `last_seen` always means "last verified live."
- **Traversal completeness signal**: context payloads carry a `traversal` block
  (`nodes_fetched`, `depth_reached`, `node_cap_hit`, `depth_limit_hit`) so a consumer can tell a
  genuine empty neighborhood from one truncated by budget, instead of silently concluding
  "nothing to find." (Was `PLAN_IMPROVMENTS.md` point 2 — done 2026-07-21.)
- **MR URL entry point**: a GitLab MR URL resolves to its Jira key (source branch → title →
  description) and runs the normal traversal (`get_context_from_mr`).
- MCP lifecycle: process exits cleanly on client disconnect (drains in-flight calls, closes the
  Neo4j handle); `yarn smoke` is a committed end-to-end stdio check.

**Left to do:**
- The MCP resource-subscription idea (push graph changes to a connected client, rather than the
  watcher only logging) is still open — no concrete design yet.

---

## 3. GitLab correlation reliability

The Jira↔GitLab bridge itself — the reason latoile exists. A silent failure here means MRs go
missing for tickets that clearly have them, which is the worst failure mode (looks like "nothing
to find" instead of "broken").

**Done:**
- **Root-caused "MRs silently empty for a ticket that clearly has them"** (`PLAN_IMPROVMENTS.md`
  point 1, resolved 2026-07-21): not a regex/matching bug — `fetchGroupProjects` broke on any
  group-API error (gitlab.com times out intermittently on these endpoints), and
  `resolveProjects` cached the resulting partial/empty project list **for the life of the
  process**. In a long-lived MCP/server process, one transient timeout on the first resolution
  silently disabled GitLab enrichment for every subsequent key. Fixed: retry once per page,
  distinguish "complete scan" from "degraded scan," and only cache a fully-complete scan
  (`lastResolutionDegraded` records the outcome otherwise).
- GitLab HTTP client (`gitlab-http.ts`) replacing `glab` process-spawning: ~15× faster,
  project-scoped MR search (group-level `?search=` times out on gitlab.com), 429 backoff honoring
  `Retry-After`/`RateLimit-Reset`, configurable concurrency.
- Direct Jira HTTP client option (`LATOILE_JIRA_URL/_EMAIL/_TOKEN`), ~15× faster than shelling
  out to `acli` when configured.

**Left to do:**
- **Known residual risk, not yet acted on**: `acli.ts` derives `hasGitlabData` from Jira's own
  dev-status hint (`customfield_10000`) and skips the GitLab search entirely when Jira says
  `false`. This hint is trusted without verification — if Jira's dev-status plugin is ever wrong
  or stale, latoile would silently miss real MRs the same way the project-resolution bug did.
  Not reproduced yet; needs a repro set (2-3 tickets: "Done, code clearly linked, GitLab empty")
  before deciding whether to soften or remove the short-circuit.
- Matching only scans commit messages / MR titles / branch names, never source-file content — a
  Jira key cited only in a code comment is invisible. Out of scope for a matching-regex fix;
  this is exactly the gap GitLab Orbit (section 4) fills instead.
- **Comment mention-parsing bug** (found 2026-08-17, not yet fixed): Jira comments returned by
  `get_context` sometimes read like "Une discussion a eu lieu entre , , et ." — not Jira-side
  redaction as originally assumed, but a real parsing bug. `src/collector/acli.ts`'s `AdfNode`
  type only reads `node.text`; an Atlassian Document Format @-mention is
  `{ type: 'mention', attrs: { text: '@Name', id } }` — the name lives in `attrs.text`, which
  `textFromDescription`'s tree-walk never reads, so mentions vanish while the surrounding literal
  punctuation ("entre ", ", ", " et ") survives. Fix: read `node.attrs?.text` for `mention` nodes.

---

## 4. GitLab Orbit (local code-graph enrichment)

Fills the blind spot section 3 explicitly can't close: latoile has no knowledge of source-file
content or code structure. GitLab Orbit is GitLab's own local code graph (`orbit` CLI →
`~/.orbit/graph.duckdb`); complementary to latoile, not competitive — Orbit never touches Jira.

**Done — Phase 0** (co-run, zero latoile code): Orbit Local installed and indexed
(`D:\repos`, ~31k files/~357k definitions/~807k relationships), registered as its own MCP server
(`orbit-local` in `.mcp.json`) alongside latoile's. Validated real value: a single query surfaced
a whole feature's frontend+backend code across repos that latoile itself couldn't see.

**Done — Phase 1** (latoile-side integration, `src/collector/orbit.ts`, opt-in
`LATOILE_ORBIT=1`): joins an issue's MR `changedFiles` (needs `LATOILE_GITLAB_FETCH_FILES=1`) to
Orbit's `gl_file`/`gl_definition` tables, attaching a `code` neighborhood per repo to each context
item. Branch-aware by design — Orbit reflects whatever branch is locally checked out, not the
MR's branch — so it distinguishes three states: not-indexed, indexed-but-no-match (branch drift,
`files_matched: 0`), and matched, rather than presenting stale code as authoritative. Verified
live across `Prescription`, `portal`, `notification-manager` with correct file/line info.
Follow-up fixes 2026-08-17 (code review on the merge): `resolveRepo` no longer grabs an arbitrary
manifest row when a repo is indexed from multiple branches (deterministic order + logged
ambiguity instead); a real Orbit CLI failure now throws and is skipped/logged rather than
silently reported as a false branch-drift match.

**Left to do:**
- **Phase 2 (spike, gated)**: evaluate Orbit *Remote* — a managed GitLab.com service indexing
  the full SDLC (MRs, work items, code) across a group — to replace latoile's O(issues × projects)
  MR-search fan-out, which is the direct cause of rate-limit pain. Gated on an unknown: whether
  Orbit Remote is enabled for this GitLab.com tier/group. Scope once known: one query for a known
  key (e.g. PV2-17843), compare results to `gitlab-http.ts`; if parity, prototype a `GitlabSource`
  behind a flag with the current HTTP client as fallback. Orbit Remote still doesn't index Jira,
  so the `acli` traversal and key-correlation stay regardless.
- **Local graph visualizer — deliberately not started.** Considered 2026-07-23: tabular
  inspection is already well served by `duckdb` CLI / Harlequin; a bespoke visualizer would solve
  a problem that doesn't exist yet. Would earn its keep specifically for exploring the *graph*
  shape (cross-repo references, at-a-glance branch-freshness) if that need materializes. If built,
  latoile's existing Cytoscape renderer (`public/`, `src/web/app.ts`) is the natural starting
  point, repointed at `gl_file`/`gl_definition`/`gl_edge`.
- Periodic re-indexing needed to keep `files_matched` meaningful — each repo is indexed at
  whatever branch happened to be checked out, and drifts from `develop2`/`main` over time.
  `scripts/orbit-reindex.ps1 -Clean` is the existing tool; no automation around it yet.

---

## 5. Agent-recorded insights (the learning loop)

latoile's stated long-term goal: learn from every investigation, not just accumulate raw
Jira/GitLab facts. MCP sampling (server-initiated LLM calls) would have been the natural
mechanism but Claude Code doesn't implement it
([anthropics/claude-code#1785](https://github.com/anthropics/claude-code/issues/1785), open,
unscheduled) — designed around instead: the *agent* using latoile already reads and reasons over
the context it returns, so it can write back what it learned as a normal side effect, no sampling
or extra API key needed.

**Done:**
- `:Insight` node + `RECORDED_ON` edge, additive (never overwrites/deletes — same discipline as
  `:Issue.missing`), multiple insights per issue accumulate rather than replace.
- `record_insight` MCP tool (`issueKey`, `entities?`, `rootCause?`, `ruledOut?`,
  `relevantComments?`).
- Surfaced back out as an optional `insights` block on `known_context` (newest first), so a later
  investigation of a related issue sees what a prior one already learned.

**Left to do:**
- **Dogfooding — not started.** Zero `:Insight` nodes exist in the live graph as of 2026-08-17.
  The mechanism is built and tested but unproven in real use; next real investigation should
  explicitly call `record_insight` with its actual diagnostic trail (including wrong hypotheses
  ruled out, not just the final answer) and then verify a later `known_context` on a related
  ticket actually surfaces it.
- No entity resolution/dedup: a person recorded from two different investigations doesn't
  automatically merge with the `:Person` identity work (section 1) unless wired explicitly —
  scoped as a deliberate follow-up, not part of the first cut.
- Not automatic and has no verification layer by design — coverage will be sparse and
  inconsistent, and stored insights should be treated as hints, not ground truth. If MCP sampling
  ever ships, it could *automate* extraction at ingest time as an addition, with `record_insight`
  staying as the manual/explicit path — not a reason to block on it now.

---

## 6. UI / visualization

The renderable graph — polish layer on top of everything above, since the same graph payload also
drives the LLM context path.

**Done:**
- Dark-only theme (company design tokens as CSS variables), Cytoscape colors read from those
  variables at render time.
- Zoom controls, search UX (ordered results, match highlighting, keyboard nav, recent lookups),
  prefs persisted to localStorage.
- Graph slimming: branch/commit nodes folded into the MR node for display (`sourceBranch`,
  `commitCount`, `commits[]`), full detail still in the details panel and in the knowledge graph.
- Edge visual hierarchy by `strength` (`src/web/app.ts`): strong structural edges (parent/subtask/
  link) render wider and solid, `has_mr` slightly wider, weak/mention edges thinner, dotted, and
  reduced opacity. (Closes the "surface strength as edge style" item from the original plan —
  already done, was just never checked off here.)

**Left to do:** nothing significant identified; this section is in steady state relative to the
rest of the roadmap.

---

## Housekeeping

- `README.md` already documents `yarn`-based commands throughout — the "still shows npm" note in
  the original plan was stale and has been dropped here.
