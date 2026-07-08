# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

latoile is a "context bridge": from a single entry-point Jira key it recursively walks the Jira relationship graph (parent, subtasks, siblings, links, key mentions in text), enriches each issue with GitLab data (MRs, branches, commits), and emits both a renderable graph (`{ nodes, edges }`) and a normalized LLM context payload. Auth is fully delegated to locally logged-in `acli` (Atlassian) and `glab` (GitLab) CLIs — no tokens in the repo.

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
- `src/collector/acli.ts` / `glab.ts` — clients that shell out to the `acli` and `glab` CLIs and parse their JSON output.
- `src/collector/traversal.ts` — breadth-first traversal from the entry key with visited-set and `maxDepth`/`maxNodes` limits; keys beyond the limits become unresolved placeholder nodes.
- `src/model/graph.ts` — `buildGraph` (visualization payload) and `buildContext` (LLM payload) from the traversal result.
- `src/api/server.ts` — Express backend; `GET /api/graph/:key` runs the pipeline live on each request (`?view=context|full`, `?maxDepth=`, `?maxNodes=`). Serves `public/` as the frontend.
- `src/cli.ts` — same pipeline as a one-shot command (`latoile` bin).
- `src/types.ts` — shared domain types (node/edge types, context payload shapes).

Dependency injection for tests: `createClients` in `pipeline.ts` and the runner's `exec` option exist so tests can stub CLI execution instead of invoking real `acli`/`glab` (see `test/collector.test.ts`, `test/traversal.test.ts`).

## Gotchas

- `acli jira workitem view` takes the key positionally (`view KEY-123`), not via `--key`. The default field set excludes `issuelinks`/`subtasks`/`parent`/`comment`, so the client passes `--fields '*all'`.
- `glab mr list` only works inside a git repo with a GitLab remote; use `glab api projects/<url-encoded-path>/...` for project-scoped queries. Group-level `?search=` requests time out on gitlab.com.
- Jira ↔ GitLab correlation is done by the "GitLab for Jira Cloud" plugin; its data sits in Jira's dev-status API (summary in `fields.customfield_10000`). See `PLAN.md` for the in-progress collector rework.
- The UI is dark-theme only, using the company design tokens (palette in `public/styles.css`).

## Domain conventions

Jira ↔ GitLab linking relies on the Jira key appearing in branch names (`feature/JIRA-123-*`), MR titles/descriptions, and commit messages. Node types: `jira`, `merge_request`, `branch`, `commit`, `doc`. Edge types: `parent`, `subtask`, `sibling`, `link`, `mention`, `has_mr`, `has_branch`, `has_commit`, `documented_by`.
