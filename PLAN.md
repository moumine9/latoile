# Plan — GitLab correlation and remaining work

Session date: 2026-07-08. Written so work can resume after the usage limit resets.

## Done in this session

- **Fixed the empty graph for PV2-17830.** `acli jira workitem view` no longer accepts `--key`; the key is positional. Also, the default field set omits `issuelinks`, `subtasks`, `parent`, and `comment`, so the client now requests `--fields '*all'` (`src/collector/acli.ts`, `viewArgs`). Verified: the CLI now returns the full parent chain for PV2-17830.
- **Dark theme applied** to `public/styles.css`, `public/index.html` (Quicksand font), and the Cytoscape colors in `src/web/app.ts`. Dark only, per request. Palette mapping: jira = info `#27b7ec`, entry = warning `#ffa726`, MR = error.light `#f46a66`, branch = primary `#93a9c1`, commit = success `#c4e49e`, doc = primary.light `#e5eaef`.
- **Zoom** in the graph canvas: explicit Cytoscape zoom options (min 0.1, max 5, wheelSensitivity 0.2) plus +/−/fit buttons bottom-right.
- **CLAUDE.md** created; yarn is the default tooling.
- All 17 tests pass (`yarn test`).

## Open problem: GitLab MRs and commits don't show up

### What was found

- The Jira ↔ GitLab correlation is done by the **"GitLab for Jira Cloud"** plugin. Its data lives in Jira's dev-status API (the "Development" panel). The issue payload only exposes a summary in `fields.customfield_10000` (e.g. PV2-17830 shows `repository: count 2`, meaning 2 repos with commits — no MR yet).
- The detail endpoint is `GET /rest/dev-status/latest/issue/detail?issueId=<numeric id>&applicationType=GitLab&dataType=pullrequest|branch|repository`. The numeric id is in the acli payload (`id: 264037` for PV2-17830).
- **acli has no raw-API command** and stores its OAuth token in the OS keyring, so we can't call dev-status through it.
- On the glab side: `glab mr list --search` (current code) fails outside a git repo — this is why every search silently returned nothing. `glab api` works fine when scoped to a **project** (`projects/:id/merge_requests?search=KEY&in=title&state=all` returns quickly). Group-level `?search=` **times out server-side** on gitlab.com. Group-level `?source_branch=` (exact match) works but branch names vary (`PV2-XXXXX`, `fix/PV2-XXXXX-...`, `Pv2-XXXXX`).
- Team convention (confirmed by sampling recent MRs): branch contains the Jira key, MR title starts with it. Example: `familiprix/priorx/Prescription!6606`, branch `fix/PV2-17818-Rx-AI-error-bubble-up`.
- Useful group id: `familiprix/priorx` = **13205630**. ~89 membership projects total; scanning all of them per Jira key is too slow.

### Recommended approach (start from the Jira workitem, per Abdoul)

1. Read `fields.customfield_10000` in `acli.ts` and parse the summary JSON (it's a string containing `json={"cachedValue":...}`). If the repository/pullrequest count is 0, skip GitLab entirely for that key — that alone kills most wasted calls.
2. Rewrite `GlabClient` to stop using `glab mr list` and use `glab api` instead:
   - `mrListArgs(key, project)` → `['api', 'projects/<urlencoded-project>/merge_requests?search=<key>&in=title&state=all&per_page=50']`
   - Keep `mrCommitsArgs` as is (already uses `glab api`).
3. Project scoping:
   - `LATOILE_GITLAB_PROJECTS` (exists) stays the precise option.
   - Add `LATOILE_GITLAB_GROUPS` (e.g. `familiprix/priorx`): resolve the project list once per pipeline run via `groups/<enc>/projects?include_subgroups=true&archived=false&per_page=100&simple=true`, cache it on the client, then fan out per-project searches with `Promise.all`.
   - If neither is set, log a clear warning instead of failing silently.
4. Optional fallback for branches with no MR yet: `projects/<enc>/repository/branches?search=<key>`.
5. Optional later: `LATOILE_JIRA_TOKEN`/`LATOILE_JIRA_EMAIL` to call dev-status directly with curl/fetch. That's the only way to get exactly what the Development panel shows, but it breaks the "no tokens in the repo" rule, so make it opt-in.

### Test notes

- PV2-17830 currently has commits but no MR, so don't use it alone to validate MR rendering. PV2-17818 has MR `familiprix/priorx/Prescription!6606`.
- Tests stub the runner (`test/collector.test.ts`); update the expected argument vectors after step 2.

## Also pending

- README still shows npm commands and the old `acli --key` behavior implicitly; update after the glab rework lands (yarn everywhere, new env vars).
