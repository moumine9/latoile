# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

latoile is a "context bridge": from a single entry-point Jira key it recursively walks the Jira relationship graph (parent, subtasks, siblings, links, key mentions in text), enriches each issue with GitLab data (MRs, branches, commits), and emits both a renderable graph (`{ nodes, edges }`) and a normalized LLM context payload. Auth piggybacks on the locally logged-in `acli` (Atlassian) and `glab` (GitLab) CLIs: Jira goes through the `acli` binary, GitLab through direct `fetch()` calls with the token read at runtime from glab's config file (`src/collector/gitlab-http.ts`). No tokens in the repo; a gitignored `.env` is auto-loaded by `src/config.ts`.

## Commands

Use **yarn** (not npm) for all package/script commands in this repo.

```bash
yarn build          # compile backend (tsconfig.json → dist/) and frontend (tsconfig.web.json → public/app.js)
yarn typecheck      # both tsconfigs, --noEmit
yarn start          # builds backend then serves Express API + UI at http://localhost:3000
yarn graph JIRA-123 --view full   # CLI fetch, no UI (dist/src/cli.js)
yarn test           # compiles backend then runs node --test dist/test/*.test.js
```

Run a single test file (tests run against compiled output, so build first):

```bash
yarn build:server && node --test dist/test/traversal.test.js
```

There is no linter configured. Tests use the Node built-in test runner (`node:test`), no test framework dependency.

## Architecture

Strict TypeScript, ESM (`"type": "module"` — source imports use `.js` extensions). Two compile targets: `tsconfig.json` builds `src/` + `test/` to `dist/` for Node; `tsconfig.web.json` builds `src/web/app.ts` to `public/app.js` for the browser. The repo convention is no `any`/`unknown` in the codebase.

Data flow: `src/pipeline.ts` (`buildContextGraph`) wires everything —

- `src/collector/runner.ts` — promisified `execFile` wrapper (argument arrays, no shell) plus a runner adding delay/retry/timeout, configured via `LATOILE_*` env vars read in `src/config.ts`.
- `src/collector/acli.ts` — Jira client shelling out to `acli`; also parses the dev-status summary (`customfield_10000`) into `hasGitlabData` so the traversal can skip GitLab lookups for issues Jira says have none.
- `src/collector/gitlab-http.ts` — the GitLab client the pipeline actually uses: `fetch()` with the token read from glab's config (or `LATOILE_GITLAB_TOKEN`); ~15× faster than spawning `glab`. `src/collector/glab.ts` is the older process-spawning client and still owns the shared normalizers (`normalizeMergeRequest`, `normalizeCommit`, `pooledMap`).
- `src/collector/traversal.ts` — breadth-first traversal from the entry key with visited-set and `maxDepth`/`maxNodes` limits; keys beyond the limits become unresolved placeholder nodes. Relations carry `strength: 'strong' | 'weak'` (weak = text mention).
- `src/model/graph.ts` — `buildGraph` (visualization payload) and `buildContext` (LLM payload) from the traversal result. `EDGE_SCHEMA` declares the valid source/target node types per edge type; `has_branch`/`has_commit` hang off the MR node, not the Jira node.
- `src/api/server.ts` — Express backend; `GET /api/graph/:key` runs the pipeline live on each request (`?view=context|full`, `?maxDepth=`, `?maxNodes=`; with `Accept: text/event-stream` it streams progress logs then the result). `GET /api/search?q=` proxies a JQL text search for the UI autocomplete. Serves `public/` as the frontend.
- `src/cli.ts` — same pipeline as a one-shot command (`latoile` bin).
- `src/types.ts` — shared domain types (node/edge types, context payload shapes).

Dependency injection for tests: `createClients` in `pipeline.ts` and the runner's `exec` option exist so tests can stub CLI execution instead of invoking real `acli`/`glab` (see `test/collector.test.ts`, `test/traversal.test.ts`).

## Gotchas

- `acli jira workitem view` takes the key positionally (`view KEY-123`), not via `--key`. The default field set excludes `issuelinks`/`subtasks`/`parent`/`comment`, so the client passes `--fields '*all'`.
- `glab mr list` only works inside a git repo with a GitLab remote, and group-level `?search=` requests time out on gitlab.com — use project-scoped API queries (`projects/<url-encoded-path>/merge_requests?search=KEY&in=title`), which is what `gitlab-http.ts` does.
- Jira ↔ GitLab correlation is done by the "GitLab for Jira Cloud" plugin; only its summary is readable from the issue payload (`fields.customfield_10000`). The detail dev-status API isn't reachable through acli, so MRs are found by searching titles/branches for the Jira key (team convention: `fix/PV2-XXXXX-...`).
- GitLab enrichment needs `LATOILE_GITLAB_GROUPS` or `LATOILE_GITLAB_PROJECTS` set (usually via the gitignored `.env`); with neither, it silently returns no MRs (a warning is logged).
- The UI defaults to dark and has a light/dark toggle; both palettes come from the company design tokens as CSS variables in `public/styles.css`. The Cytoscape colors are read from those variables at render time (`getThemeColor` in `src/web/app.ts`).
- `acli` calls take ~5s each (process spawn); that's the pipeline bottleneck. See `PLAN.md` for pending work.

## Domain conventions

Jira ↔ GitLab linking relies on the Jira key appearing in branch names (`feature/JIRA-123-*`), MR titles/descriptions, and commit messages. Node types: `jira`, `merge_request`, `branch`, `commit`, `doc`. Edge types: `parent`, `subtask`, `sibling`, `link`, `mention` (Jira ↔ Jira); `has_mr` (Jira → MR); `has_branch`, `has_commit` (MR → branch/commit); `documented_by` (Jira → doc). Source/target constraints live in `EDGE_SCHEMA` (`src/model/graph.ts`); every edge has `strength: 'strong' | 'weak'` (weak = text mention only).
