# latoile

## Intermediary layer: GitLab + Jira context for LLMs

This repository now defines a minimal **Context Bridge** between:
- **GitLab**: merge requests, branches, commits
- **Jira**: tasks, subtasks, bugs, Confluence documentation links

The goal is to provide one normalized payload that an LLM can consume without querying both systems independently.

From a single **entry-point Jira key**, latoile recursively walks the Jira
relationship graph (parent, subtasks, siblings, issue links, and keys mentioned
in descriptions/comments), enriches every issue with its GitLab context (merge
requests, branches, commits), builds a graph, and serves it through a **live
backend** plus an interactive **frontend** visualizer.

Authentication piggybacks on the locally logged-in `acli` (Atlassian) and
`glab` (GitLab) CLI sessions **by default**. For much faster startup, both
clients can bypass their CLIs entirely:

- **Jira**: set `LATOILE_JIRA_URL` + `LATOILE_JIRA_EMAIL` + `LATOILE_JIRA_TOKEN`
  (Atlassian API token from https://id.atlassian.com/manage-profile/security/api-tokens).
  Each issue fetch drops from ~5 s (acli spawn) to ~0.3 s.
- **GitLab**: the HTTP client reads the PAT from your local glab config automatically
  (`%LOCALAPPDATA%\glab-cli\config.yml` on Windows). Can be overridden with
  `LATOILE_GITLAB_TOKEN`. No credentials are stored in this repository.

### Quick start

This repo uses **yarn**.

```bash
yarn install
yarn build              # compile TypeScript (backend + frontend) to dist/ and public/app.js

# 1) Live backend + frontend (runs acli/glab on demand)
yarn start              # → http://localhost:3000
# open the UI, enter a Jira key, or deep-link: http://localhost:3000/?key=JIRA-123

# 2) Direct data fetch, no UI (writes JSON to stdout or a file)
yarn graph JIRA-123 --view full --out JIRA-123.graph.json
# or, after building: node dist/src/cli.js JIRA-123 --view full
```

Note: the Jira client calls `acli jira workitem view <KEY> --fields '*all' --json`
(the key is positional; older acli versions used `--key`, which current versions
reject). If issues come back empty, check `acli jira auth status` first.

### How GitLab data is found

Jira's "GitLab for Jira Cloud" plugin writes a dev-status summary into each
issue (`customfield_10000`). The collector reads it as a hint: when Jira says
an issue has zero branches, commits, and MRs, the GitLab lookup is skipped
entirely. Otherwise MRs are searched by Jira key in the title across your
configured projects or groups (the team convention: branch names and MR titles
contain the key, e.g. `fix/PV2-17818-...`).

GitLab calls go through `src/collector/gitlab-http.ts`, which uses `fetch()`
with the token of your logged-in `glab` session (read from glab's config file
at runtime, or from `LATOILE_GITLAB_TOKEN`). This is roughly 15× faster than
spawning a `glab` process per request. The `glab`-spawning client
(`src/collector/glab.ts`) is still there and shares the same normalizers.

### Backend API (live)

Every request runs the collector against `acli` and the GitLab API on demand.

| Endpoint | Description |
| --- | --- |
| `GET /api/graph/:key` | Renderable graph `{ nodes, edges }` (default) |
| `GET /api/graph/:key?view=context` | Normalized LLM context payload |
| `GET /api/graph/:key?view=full` | Both graph and context |
| `GET /api/search?q=text` | Jira text search (top 8 matches, for the UI autocomplete) |
| `GET /api/resolve-mr?url=…` | Resolves a GitLab MR link to its Jira key (paste-a-link flow) |
| `GET /api/health` | Liveness probe |

Query params: `maxDepth` (traversal depth), `maxNodes` (node cap), and
`refresh=1` (bypass the fetch cache) override the defaults per request. Requesting `/api/graph/:key` with `Accept: text/event-stream`
streams progress logs as server-sent events, then the final payload — the UI
uses this for its loading indicator.

Example:

```bash
curl "http://localhost:3000/api/graph/JIRA-123?view=context&maxDepth=2"
```

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Backend HTTP port |
| `LATOILE_MAX_DEPTH` | `1` | Traversal depth from the entry point |
| `LATOILE_MAX_NODES` | `50` | Hard cap on fetched Jira nodes |
| `LATOILE_GITLAB_PROJECTS` | _(empty)_ | Comma-separated `group/project` paths to search (takes precedence over groups) |
| `LATOILE_GITLAB_GROUPS` | _(empty)_ | Comma-separated group paths or IDs; projects are enumerated once per run |
| `LATOILE_GITLAB_ACTIVE_DAYS` | `90` | Skip group projects with no activity in this many days |
| `LATOILE_GITLAB_CONCURRENCY` | `8` | Max parallel GitLab API requests |
| `LATOILE_GITLAB_TOKEN` | _(empty)_ | Override the token normally read from glab's config |
| `LATOILE_JIRA_URL` | _(empty)_ | e.g. `https://your-org.atlassian.net`; enables the direct Jira HTTP client |
| `LATOILE_JIRA_EMAIL` | _(empty)_ | Atlassian account email (used with `LATOILE_JIRA_TOKEN`) |
| `LATOILE_JIRA_TOKEN` | _(empty)_ | Atlassian API token — when set with URL+email, replaces acli (~15× faster) |
| `LATOILE_CLI_DELAY_MS` | `0` | Delay between CLI calls (rate limiting) |
| `LATOILE_CLI_RETRIES` | `2` | Retries on transient CLI failures |
| `LATOILE_CLI_TIMEOUT_MS` | `30000` | Per CLI-call timeout |
| `LATOILE_ACLI_BIN` / `LATOILE_GLAB_BIN` | `acli` / `glab` | Binary overrides |
| `LATOILE_CACHE` | `on` | Set to `off` to disable the SQLite fetch cache |
| `LATOILE_CACHE_PATH` | `~/.latoile/cache.db` | Cache file location |
| `LATOILE_CACHE_TTL_MIN` | `15` | Cache freshness window in minutes |

A `.env` file in the project root (gitignored) is loaded at startup; shell
exports win over `.env` values. Set at least `LATOILE_GITLAB_GROUPS` or
`LATOILE_GITLAB_PROJECTS`, otherwise GitLab enrichment returns nothing and
logs a warning.

### Fetch cache

Jira issues and GitLab lookups are cached in a single-file SQLite database
(Node's built-in `node:sqlite`, so Node ≥ 22.13 is required — no native
dependency). Entries expire after `LATOILE_CACHE_TTL_MIN` minutes; repeat
lookups within the window are near-instant. `?refresh=1` (API) or
`refresh: true` (pipeline/MCP) forces live fetches while still updating the
cache. Failed Jira lookups are never cached.

### MCP server

latoile exposes its pipeline as an MCP tool so coding agents can pull ticket
context mid-conversation:

```bash
yarn build:server
claude mcp add latoile -- node /path/to/latoile/dist/src/mcp/server.js
```

Three tools are exposed, all returning structured content:

| Tool | Purpose |
| --- | --- |
| `get_context(jiraKey, maxDepth?, maxNodes?, refresh?)` | Full traversal → normalized LLM context payload |
| `get_context_from_mr(mrUrl, …)` | Same, from a GitLab MR link — the Jira key is extracted from the MR's source branch, title, or description (`resolved_from` block says which) |
| `search_issues(query, limit?)` | JQL full-text search, newest-updated first — find the key when only a topic is known |
| `get_issue(jiraKey)` | Single issue (status, parent, subtasks, links…), no traversal — fast and cache-backed |

`get_context` streams pipeline progress as MCP progress notifications when the
client provides a `progressToken`, and always as logging notifications.
Configuration comes from the same environment / `.env` as the server, resolved
from the working directory the MCP server is started in. Run it manually with
`yarn mcp`.

### Project layout

The project is written in **TypeScript**. The backend compiles to `dist/` and the
frontend compiles to `public/app.js` (see `tsconfig.json` / `tsconfig.web.json`).

```
src/
  collector/   acli & glab clients, CLI runner, recursive BFS traversal
  model/       graph builder + normalized LLM context builder
  api/         live Express backend
  web/         frontend visualizer source (compiled to public/app.js)
  types.ts     shared domain types
  pipeline.ts  wires collector → model
  cli.ts       command-line entry point
public/        frontend static assets (Cytoscape UI; app.js is generated)
test/          unit + integration tests (node --test)
dist/          compiled backend + tests (generated, git-ignored)
```

Build with `yarn build` and run the tests with `yarn test` (the `pretest`
hook compiles the backend first). Type-check without emitting via `yarn typecheck`.

> The frontend loads **Cytoscape 3.30.2** and the **Quicksand** font from CDNs
> (pinned in `public/index.html`). Cytoscape is not an npm dependency; update
> both the CDN tag and this note together when bumping the version.

The UI ships light and dark palettes built from the company design tokens
(`public/styles.css`), defaulting to dark with a toggle in the header. The
search box autocompletes against `/api/search` when you type text instead of
a key. The canvas supports mouse-wheel and pinch zoom, +/−/fit buttons, PNG
and JSON export, and double-clicking a node opens it in Jira or GitLab (set
`LATOILE_JIRA_BASE_URL` for Jira links).

### Unified context model

```json
{
  "work_item": {
    "id": "JIRA-123",
    "type": "task|subtask|bug",
    "title": "Short summary",
    "status": "In Progress",
    "assignee": "user",
    "parent_id": "JIRA-100"
  },
  "gitlab": {
    "merge_request": {
      "id": 42,
      "title": "feat: improve checkout validation",
      "state": "opened",
      "source_branch": "feature/JIRA-123-checkout-validation",
      "target_branch": "main",
      "url": "https://gitlab.example.com/group/project/-/merge_requests/42"
    },
    "branch": {
      "name": "feature/JIRA-123-checkout-validation",
      "last_commit_sha": "abc123..."
    },
    "commits": [
      {
        "sha": "abc123...",
        "title": "feat: add checkout guard",
        "author": "user",
        "timestamp": "2026-07-08T10:00:00Z"
      }
    ]
  },
  "documentation": [
    {
      "source": "confluence",
      "title": "Checkout validation design",
      "url": "https://confluence.example.com/display/TEAM/Checkout+Validation"
    }
  ],
  "traceability": {
    "links": [
      {
        "jira_key": "JIRA-123",
        "merge_request_id": 42,
        "commit_sha": "abc123..."
      }
    ]
  }
}
```

### Graph model

Beyond the per-issue context object, latoile emits a graph payload
(`{ nodes, edges }`) for visualization:

- **Node types**: `jira`, `merge_request`, `doc`. Branches and commits are not
  separate nodes: the MR node carries `sourceBranch`, `commitCount`, and the
  `commits` list (shown in the UI details panel).
- **Edge types**: `parent`, `subtask`, `sibling`, `link` (typed), `mention`
  (Jira ↔ Jira); `has_mr` (Jira → MR); `documented_by` (Jira → doc). The valid
  source/target types per edge are declared in `EDGE_SCHEMA`
  (`src/model/graph.ts`).
- Every edge carries a `strength`: `strong` for structural Jira links,
  `weak` for text mentions. Consumers can filter on it.
- The entry-point node is flagged (`isEntry`) and highlighted in the frontend;
  keys discovered beyond `maxDepth`/`maxNodes` appear as unresolved placeholders.

### Bridge behavior

1. Resolve the entry Jira issue and traverse parent, subtasks, siblings, issue
   links, and description/comment mentions (breadth-first, visited-set,
   depth/node limits).
2. Resolve GitLab merge requests, branches, and commits related to each Jira key.
3. Attach relevant Confluence / remote documentation links.
4. Output one normalized JSON context object (example above) for LLM prompts, and
   a graph payload for the frontend.

### Suggested linking rules

- Branch names should include the Jira key (`feature/JIRA-123-*`).
- Merge request title/description should include the Jira key.
- Commit messages should include the Jira key when possible.
- Confluence links should be attached through Jira issue links or labels.
