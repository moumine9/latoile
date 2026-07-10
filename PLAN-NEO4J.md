# Plan — Neo4j knowledge-graph layer

Goal: make laToile *remember everything*. Today each run rebuilds its graph from
live fetches and throws it away (the SQLite cache only speeds up refetching).
This layer persists every node and edge laToile has ever seen into a local
Neo4j database, so coverage accumulates across runs and the graph becomes
queryable across tickets ("what connects PV2-17818 to PV2-16002?", "what has
Alice touched this sprint?", "which issues' MRs touched Prescription?").

## Principles

- **Additive, never authoritative.** Jira/GitLab stay the source of truth; the
  knowledge graph is an accumulating index with freshness timestamps. Nothing
  is ever deleted by the pipeline; staleness is expressed as `last_seen`.
- **Degrade gracefully.** No Neo4j configured / reachable → laToile works
  exactly as today. The sink must never fail a pipeline run (log a warning,
  drop the write).
- **Separate from the fetch cache.** SQLite answers "did I fetch this
  recently?"; Neo4j answers "what do I know?". Different lifecycles, different
  stores — do not merge them.
- **Richer than the viz graph.** The UI dropped branch/commit nodes for
  clarity; the knowledge graph keeps them (plus people), because cross-ticket
  queries need them. Persist from the `TraversalResult` (raw), not from
  `buildGraph` (display-slimmed).

## Data model

Nodes (all carry `first_seen`, `last_seen` datetimes):

| Label | Key (MERGE on) | Properties |
| --- | --- | --- |
| `:Issue` | `key` | title, type, status, assignee, resolved, url |
| `:MergeRequest` | `project + iid` | title, state, sourceBranch, targetBranch, url |
| `:Commit` | `sha` | title, timestamp |
| `:Person` | `name` (best available identity) | — |
| `:Doc` | `url` | source, title |

Relationships (mirror `EDGE_SCHEMA` semantics, plus what the viz dropped):

- `(:Issue)-[:PARENT_OF|HAS_SUBTASK|LINKS_TO {linkType}|MENTIONS {strength}]->(:Issue)`
  — store `strength` on all Jira↔Jira edges; sibling edges are **not**
  persisted (derivable from shared parents, and we already learned the
  clique lesson in the viz).
- `(:Issue)-[:HAS_MR]->(:MergeRequest)-[:HAS_COMMIT]->(:Commit)`
- `(:Commit)-[:AUTHORED_BY]->(:Person)`, `(:Issue)-[:ASSIGNED_TO]->(:Person)`,
  `(:MergeRequest)-[:AUTHORED_BY]->(:Person)`
- `(:Issue)-[:DOCUMENTED_BY]->(:Doc)`

Constraints at startup: uniqueness on each label's key (`CREATE CONSTRAINT IF
NOT EXISTS`). Schema version stamped on a `(:Meta)` node for future migration.

## Architecture

```
traverse() ──▶ TraversalResult ──▶ buildGraph / buildContext   (unchanged)
                     │
                     └─▶ GraphSink.ingest(result)              (new, fire-safe)
```

- `src/sink/graph-sink.ts` — `interface GraphSink { ingest(result: TraversalResult): Promise<void>; close(): Promise<void>; }`
  The pipeline depends only on this; Neo4j is one implementation. (Same
  pattern as `CacheStore` — a future backend swap stays cheap.)
- `src/sink/neo4j-sink.ts` — implementation on the official `neo4j-driver`.
  One batched write transaction per ingest: `UNWIND $issues … MERGE`,
  `UNWIND $relations … MERGE`, set `last_seen = datetime()`, set
  `first_seen` only `ON CREATE`. Unresolved placeholder issues are persisted
  with `resolved: false` so the graph knows the frontier it hasn't explored.
- `src/pipeline.ts` — after `traverse()`, `await sink.ingest(traversal)` inside
  try/catch (warning log on failure); shared singleton like the cache store.
- Config (`src/config.ts`): `LATOILE_NEO4J_URI` (e.g. `bolt://localhost:7687`),
  `LATOILE_NEO4J_USER`, `LATOILE_NEO4J_PASSWORD`, `LATOILE_NEO4J=off` kill
  switch. Sink is created only when the URI is present.
- Local dev: `docker-compose.yml` with `neo4j:5-community`, volume for data,
  README section (browser UI at http://localhost:7474 is the free win —
  Cypher exploration with zero code).

## Query surface (MCP tools, phase 2)

Canned, parameterized Cypher — no raw-Cypher tool initially (injection and
foot-gun risk; revisit behind an env flag if needed):

- `find_connection(keyA, keyB)` — shortest path(s) between two issues, any
  edge type; returns the path as a node/edge list an agent can narrate.
- `known_context(jiraKey)` — what the graph already knows offline: the stored
  neighborhood with freshness timestamps. Instant; a `staleness` field tells
  the agent when to fall back to live `get_context`.
- `person_activity(name, sinceDays?)` — issues assigned, MRs/commits authored.
- `graph_stats()` — node/edge counts by type, oldest/newest `last_seen` —
  answers "how much does laToile remember?".

The existing live tools stay untouched; the knowledge graph adds the fast,
offline path. Later, `get_context` can consult `known_context` first and only
traverse the stale frontier (incremental refresh — the real speed prize).

## Phases

1. **Ingest (core, ~1 session).** GraphSink interface, Neo4jSink with batched
   upserts + constraints, pipeline hook, config, docker-compose, unit tests
   with a fake driver session (assert generated Cypher + params), README/CLAUDE
   docs. Exit criterion: run `get_context` on a few tickets, open Neo4j
   browser, see the accumulated graph; re-running updates `last_seen` without
   duplicating.
2. **Query tools (~1 session).** The four MCP tools above + tests (fake
   driver). Exit criterion: `find_connection` between two tickets that share
   only an old epic returns the path without any live Jira call.
3. **Freshness & enrichment (later, design first).**
   - Incremental refresh: traverse only nodes whose `last_seen` exceeds a
     threshold; needs care around deleted/moved issues (mark `missing` rather
     than delete).
   - MR diff ingestion (`:File` nodes, `TOUCHES` edges) to unlock "issues
     whose MRs touched file X" — new GitLab API calls, volume concerns, so
     separate design.
   - Background watcher (cron/Monitor) feeding the graph + "what changed since
     Monday" diffing; ties into the MCP resource-subscription idea.

## Risks / open questions

- **Identity of people**: Jira assignee names vs GitLab usernames won't always
  match; start with separate `:Person` nodes per source value, merge later
  with a mapping table rather than guessing now.
- **Data locality/PII**: the DB contains internal ticket text on the dev's
  machine — same exposure as the SQLite cache; document it, keep the volume
  gitignored, no remote Neo4j by default.
- **Driver dependency**: `neo4j-driver` is pure JS (no native build) — safe.
  Keep it a regular dependency but lazy-import it in the sink so `yarn start`
  without Neo4j config never loads it.
- **Write volume**: a 50-node traversal is trivial for one transaction; no
  batching concerns until MR diffs (phase 3).
- **Merge semantics for renamed MRs/titles**: MERGE on stable keys and
  overwrite mutable props with the latest values — last write wins is correct
  here because fresher data is better data.
