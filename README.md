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

Authentication is delegated entirely to the locally logged-in `acli` (Atlassian)
and `glab` (GitLab) CLI sessions — no tokens are read from or stored in the repo.

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

Known gap: GitLab merge requests and commits are correlated by the
"GitLab for Jira Cloud" plugin on the Jira side, and that data is not yet
read by the collector. `PLAN.md` describes the fix in progress.

### Backend API (live)

Every request runs the collector against `acli` / `glab` on demand.

| Endpoint | Description |
| --- | --- |
| `GET /api/graph/:key` | Renderable graph `{ nodes, edges }` (default) |
| `GET /api/graph/:key?view=context` | Normalized LLM context payload |
| `GET /api/graph/:key?view=full` | Both graph and context |
| `GET /api/health` | Liveness probe |

Query params: `maxDepth` (traversal depth) and `maxNodes` (node cap) override the
defaults per request.

Example:

```bash
curl "http://localhost:3000/api/graph/JIRA-123?view=context&maxDepth=2"
```

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Backend HTTP port |
| `LATOILE_MAX_DEPTH` | `2` | Traversal depth from the entry point |
| `LATOILE_MAX_NODES` | `100` | Hard cap on fetched Jira nodes |
| `LATOILE_GITLAB_PROJECTS` | _(empty)_ | Comma-separated `group/project` scopes to search |
| `LATOILE_CLI_DELAY_MS` | `0` | Delay between CLI calls (rate limiting) |
| `LATOILE_CLI_RETRIES` | `2` | Retries on transient CLI failures |
| `LATOILE_CLI_TIMEOUT_MS` | `30000` | Per CLI-call timeout |
| `LATOILE_ACLI_BIN` / `LATOILE_GLAB_BIN` | `acli` / `glab` | Binary overrides |

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

The UI is dark-theme only, styled after the company design tokens (see
`public/styles.css` for the palette). The canvas supports mouse-wheel and
pinch zoom, plus the +/−/fit buttons in the bottom-right corner.

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

- **Node types**: `jira`, `merge_request`, `branch`, `commit`, `doc`.
- **Edge types**: `parent`, `subtask`, `sibling`, `link` (typed), `mention`
  (Jira ↔ Jira); `has_mr`, `has_branch`, `has_commit` (Jira → GitLab);
  `documented_by` (Jira → doc).
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
