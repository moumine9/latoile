/**
 * GitLab HTTP client — uses fetch() with the token from the locally logged-in
 * glab CLI session instead of shelling out to `glab` for every API call.
 *
 * Security model: identical to GlabClient. The PAT is read at runtime from
 * glab's config file on disk — never stored in the repository.
 *
 * Performance: ~0.3–0.5 s per request vs ~6.5 s per `glab` process spawn,
 * with connection keep-alive across concurrent requests.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isJiraKey } from './jiraKeys.js';
import { normalizeMergeRequest, normalizeCommit, pooledMap } from './glab.js';
import type { RawMergeRequest, RawCommit } from './glab.js';
import type { Commit, GitlabContext, LogFn, MergeRequest } from '../types.js';

/* -------------------------------------------------------------------------- */
/* Token discovery                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reads the GitLab PAT from the locally logged-in glab CLI configuration.
 * Tries the Windows and Unix paths in order; returns `undefined` when not found.
 * Callers can override with the `LATOILE_GITLAB_TOKEN` environment variable.
 */
export function readGlabToken(host = 'gitlab.com'): string | undefined {
  const envToken = process.env['LATOILE_GITLAB_TOKEN'];
  if (envToken) return envToken;

  const candidates: string[] = [
    process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'glab-cli', 'config.yml') : '',
    join(homedir(), '.config', 'glab-cli', 'config.yml'),
    join(homedir(), '.glab-cli', 'config.yml'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf8');
      // Config YAML structure:
      //   hosts:
      //     gitlab.com:
      //       token: glpat-...
      // We look for the host key, then the first `token:` line below it.
      const hostIdx = content.indexOf(`${host}:`);
      if (hostIdx < 0) continue;
      const section = content.slice(hostIdx);
      const match = section.match(/^\s+token:\s*([^\s#\n]+)/m);
      if (match?.[1]) return match[1];
    } catch {
      // Unreadable config — try next path
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Raw GitLab REST shapes                                                      */
/* -------------------------------------------------------------------------- */

type RawProject = {
  id?: number;
  path_with_namespace?: string;
  last_activity_at?: string;
}

type RawDiff = {
  old_path?: string;
  new_path?: string;
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

/** Injectable fetch function — matches the global `fetch` signature. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Error thrown by `apiGet` carrying the HTTP status, so callers can branch on
 * the real status code (e.g. 429 vs. 403) instead of substring-matching the
 * message — the message embeds the request path and response body, which can
 * incidentally contain those digits.
 */
export class GitlabApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitlabApiError';
    this.status = status;
  }
}

export type GitlabHttpClientDeps = {
  /** GitLab PAT. Defaults to reading from glab config / LATOILE_GITLAB_TOKEN. */
  token?: string;
  /** GitLab hostname, default `gitlab.com`. */
  host?: string;
  /** Explicit project paths to search (takes precedence over `groups`). */
  projects?: string[];
  /** Groups whose projects are enumerated once per client lifetime. */
  groups?: string[];
  /** Projects inactive for longer than this are excluded from group scans. */
  activeDays?: number;
  /** Max concurrent requests (default 20 — safe with fetch keep-alive). */
  concurrency?: number;
  /**
   * Opt-in: fetch each MR's changed file paths (one extra API call per MR).
   * Off by default — volume scales with MR count per traversal.
   */
  fetchChangedFiles?: boolean;
  /** Max retries on an HTTP 429 before giving up on a single request (default 4). */
  maxRetries?: number;
  /** Cap on any single rate-limit backoff wait, in ms (default 60_000). */
  maxBackoffMs?: number;
  /** Sleep implementation — injectable so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Fetch implementation — injectable for tests. */
  fetch?: FetchFn;
  log?: LogFn;
}

/**
 * GitLab API client using direct HTTP calls via `fetch()`.
 *
 * Reads the auth token from the local glab CLI session so no credentials are
 * stored in the repository. Projects can be configured explicitly via
 * `projects` or discovered from `groups` (resolved once and cached).
 * Only projects with activity within `activeDays` are searched when using
 * group discovery.
 */
export class GitlabHttpClient {
  token: string;
  baseUrl: string;
  projects: string[];
  groups: string[];
  activeDays: number;
  concurrency: number;
  fetchChangedFiles: boolean;
  maxRetries: number;
  maxBackoffMs: number;
  sleep: (ms: number) => Promise<void>;
  fetch: FetchFn;
  log: LogFn;
  _cachedProjects: string[] | null;
  /**
   * Set when the most recent project resolution could not scan every configured
   * group completely (API error / timeout). A degraded resolution is never
   * cached, so callers can distinguish "no MRs found" from "search was partial".
   */
  lastResolutionDegraded: boolean;

  constructor({
    token,
    host = 'gitlab.com',
    projects = [],
    groups = [],
    activeDays = 90,
    concurrency = 20,
    fetchChangedFiles = false,
    maxRetries = 4,
    maxBackoffMs = 60_000,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetch: fetchImpl = globalThis.fetch,
    log = () => {},
  }: GitlabHttpClientDeps) {
    this.token = token ?? readGlabToken(host) ?? '';
    this.baseUrl = `https://${host}/api/v4`;
    this.projects = Array.isArray(projects) ? projects : [];
    this.groups = Array.isArray(groups) ? groups : [];
    this.activeDays = activeDays > 0 ? activeDays : 90;
    this.concurrency = concurrency > 0 ? concurrency : 20;
    this.fetchChangedFiles = fetchChangedFiles;
    this.maxRetries = maxRetries >= 0 ? maxRetries : 4;
    this.maxBackoffMs = maxBackoffMs > 0 ? maxBackoffMs : 60_000;
    this.sleep = sleep;
    this.fetch = fetchImpl;
    this.log = log;
    this._cachedProjects = null;
    this.lastResolutionDegraded = false;
  }

  /**
   * Makes an authenticated GET request and returns the parsed JSON body.
   *
   * On HTTP 429 (rate limited) the request is retried up to `maxRetries` times,
   * waiting the server-directed interval (`Retry-After` seconds, or the
   * `RateLimit-Reset` epoch) when present and otherwise an exponential backoff,
   * always capped at `maxBackoffMs`. Because every project/commit/group request
   * funnels through here, this single choke point protects the whole fan-out.
   */
  async apiGet<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/${path}`;
    for (let attempt = 0; ; attempt += 1) {
      const resp = await this.fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (resp.ok) return resp.json() as Promise<T>;

      if (resp.status === 429 && attempt < this.maxRetries) {
        const waitMs = this.rateLimitWaitMs(resp, attempt);
        // Discard the unread body so the connection is released before the next
        // attempt; otherwise abandoned response streams accumulate across the
        // large issues×projects fan-out and can exhaust sockets.
        await resp.body?.cancel().catch(() => {});
        this.log(
          `gitlab: 429 rate limited on ${path}; waiting ${Math.round(waitMs / 1000)}s ` +
            `(retry ${attempt + 1}/${this.maxRetries})`
        );
        await this.sleep(waitMs);
        continue;
      }

      const body = await resp.text().catch(() => '');
      throw new GitlabApiError(
        resp.status,
        `GitLab API ${resp.status} ${resp.statusText} — ${path}${body ? `: ${body.slice(0, 200)}` : ''}`
      );
    }
  }

  /**
   * Computes how long to wait after a 429, preferring the server's own signal:
   * `Retry-After` (seconds) or `RateLimit-Reset` (Unix epoch seconds). Falls
   * back to exponential backoff (1s, 2s, 4s, …). The result is clamped to
   * `maxBackoffMs` so a misreported header can never stall the pipeline.
   */
  rateLimitWaitMs(resp: Response, attempt: number): number {
    const retryAfter = Number(resp.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter * 1000, this.maxBackoffMs);
    }
    const reset = Number(resp.headers.get('ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
      const deltaMs = reset * 1000 - Date.now();
      if (deltaMs > 0) return Math.min(deltaMs, this.maxBackoffMs);
    }
    return Math.min(1000 * 2 ** attempt, this.maxBackoffMs);
  }

  /**
   * Fetches all projects in a GitLab group (including subgroups), filtered to
   * those with activity within `this.activeDays`. Sorted by recency so early
   * pages are the most relevant. Pagination stops as soon as all items on a
   * page are older than the cutoff.
   *
   * Returns the resolved projects plus a `complete` flag: `false` means a page
   * failed even after retry, so the list is partial and must not be treated as
   * authoritative (see `resolveProjects`). These group endpoints time out
   * intermittently on gitlab.com, so each page is retried once.
   */
  async fetchGroupProjects(group: string): Promise<{ projects: string[]; complete: boolean }> {
    const cutoffMs = Date.now() - this.activeDays * 24 * 60 * 60 * 1000;
    const results: string[] = [];
    let page = 1;

    for (;;) {
      const encoded = encodeURIComponent(group);
      const path =
        `groups/${encoded}/projects` +
        `?include_subgroups=true&archived=false&per_page=100&simple=true` +
        `&order_by=last_activity_at&sort=desc&page=${page}`;

      let data: RawProject[];
      try {
        data = await this.apiGetWithRetry<RawProject[]>(path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`gitlab: group project list failed for ${group} (page ${page}): ${msg}`);
        // Partial list: signal incompleteness so the caller doesn't cache it.
        return { projects: results, complete: false };
      }

      if (data.length === 0) break;

      for (const p of data) {
        if (!p.path_with_namespace) continue;
        if (p.last_activity_at && new Date(p.last_activity_at).getTime() < cutoffMs) continue;
        results.push(p.path_with_namespace);
      }

      // Since results are sorted by last_activity_at desc, stop when the last
      // item on this page is already older than our cutoff.
      const last = data[data.length - 1];
      const allStale =
        last?.last_activity_at !== undefined &&
        new Date(last.last_activity_at).getTime() < cutoffMs;
      if (allStale || data.length < 100) break;
      page++;
    }

    return { projects: results, complete: true };
  }

  /**
   * `apiGet` with a single extra retry for transient *timeout* errors. The
   * group-projects and group-MR endpoints on gitlab.com return sporadic
   * timeouts; one re-attempt turns most of those into a success instead of
   * poisoning the resolved project set. Rate-limit (429) errors are NOT retried
   * here — `apiGet` already backs off and exhausts its own 429 budget, so a
   * second immediate attempt would only add pressure.
   */
  async apiGetWithRetry<T>(path: string): Promise<T> {
    try {
      return await this.apiGet<T>(path);
    } catch (err) {
      // Don't re-attempt a rate-limit: apiGet already exhausted its 429 budget.
      // Branch on the real status, never the message text (which embeds the
      // path/body and could contain "429" for unrelated errors).
      if (err instanceof GitlabApiError && err.status === 429) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`gitlab: retrying ${path} after error: ${msg}`);
      return this.apiGet<T>(path);
    }
  }

  /**
   * Resolves the project list from `projects` or `groups`. A successful,
   * complete scan is cached for the client lifetime. A degraded scan (any group
   * failed to enumerate fully) is returned best-effort for this call but is
   * NOT cached, so the next `fetchForKey` retries resolution instead of reusing
   * a poisoned/partial set. `lastResolutionDegraded` records the outcome.
   */
  async resolveProjects(): Promise<string[]> {
    if (this.projects.length > 0) {
      this.lastResolutionDegraded = false;
      return this.projects;
    }
    if (this._cachedProjects !== null) {
      this.lastResolutionDegraded = false;
      return this._cachedProjects;
    }
    if (this.groups.length === 0) {
      this._cachedProjects = [];
      this.lastResolutionDegraded = false;
      return [];
    }

    const all: string[] = [];
    let complete = true;
    for (const group of this.groups) {
      const { projects, complete: groupComplete } = await this.fetchGroupProjects(group);
      all.push(...projects);
      if (!groupComplete) complete = false;
    }
    const resolved = [...new Set(all)];
    this.lastResolutionDegraded = !complete;

    if (!complete) {
      this.log(
        `gitlab: project resolution incomplete (${resolved.length} projects from ${this.groups.join(', ')}) ` +
          `— MR results may be partial; not caching so the next lookup retries`
      );
      return resolved;
    }

    this._cachedProjects = resolved;
    this.log(`gitlab: ${resolved.length} active projects resolved from ${this.groups.join(', ')}`);
    return resolved;
  }

  /** Searches MRs for a Jira key within a single project, then fetches commits. */
  async searchProject(key: string, project: string): Promise<MergeRequest[]> {
    const encoded = encodeURIComponent(project);
    let list: RawMergeRequest[];
    try {
      list = await this.apiGet<RawMergeRequest[]>(
        `projects/${encoded}/merge_requests?search=${encodeURIComponent(key)}&in=title&state=all&per_page=50`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 403 = project visible in group listing but MR access restricted — skip silently.
      if (!msg.includes('403')) {
        this.log(`gitlab: MR search failed for ${key} in ${project}: ${msg}`);
      }
      return [];
    }

    const mergeRequests: MergeRequest[] = [];
    for (const item of list) {
      const mr = normalizeMergeRequest(item, project);
      if (!mr) continue;
      mr.commits = await this.fetchCommits(mr).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('403')) {
          this.log(`gitlab: commits failed for MR ${project}!${mr.iid}: ${msg}`);
        }
        return [];
      });
      if (this.fetchChangedFiles) {
        mr.changedFiles = await this.fetchDiffPaths(mr).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('403')) {
            this.log(`gitlab: diffs failed for MR ${project}!${mr.iid}: ${msg}`);
          }
          return [];
        });
      }
      mergeRequests.push(mr);
    }
    return mergeRequests;
  }

  /** Fetches commits for an already-normalized MR. */
  async fetchCommits(mr: MergeRequest): Promise<Commit[]> {
    if (!mr.project || !mr.iid) return [];
    const encoded = encodeURIComponent(mr.project);
    const data = await this.apiGet<RawCommit[]>(
      `projects/${encoded}/merge_requests/${mr.iid}/commits`
    );
    return data.map(normalizeCommit).filter((c): c is Commit => c !== null);
  }

  /**
   * Fetches the distinct file paths an MR touches (paths only, no diff
   * content — keeps the payload small). Uses the paginated `diffs` endpoint;
   * one extra API call per MR page, so this is only invoked when
   * `fetchChangedFiles` is enabled.
   */
  async fetchDiffPaths(mr: MergeRequest): Promise<string[]> {
    if (!mr.project || !mr.iid) return [];
    const encoded = encodeURIComponent(mr.project);
    const paths = new Set<string>();
    let page = 1;
    for (;;) {
      const data = await this.apiGet<RawDiff[]>(
        `projects/${encoded}/merge_requests/${mr.iid}/diffs?per_page=100&page=${page}`
      );
      for (const d of data) {
        const path = d.new_path || d.old_path;
        if (path) paths.add(path);
      }
      if (data.length < 100) break;
      page++;
    }
    return [...paths];
  }

  /**
   * Resolves all GitLab context for a single Jira key. Fans out across all
   * configured projects with concurrency limiting, deduplicates by MR iid.
   * Never throws: on failure it logs and returns partial data.
   */
  async fetchForKey(key: string): Promise<GitlabContext> {
    if (!isJiraKey(key)) return { mergeRequests: [] };

    if (!this.token) {
      this.log('gitlab: no token — log in with `glab auth login` or set LATOILE_GITLAB_TOKEN');
      return { mergeRequests: [] };
    }

    const projects = await this.resolveProjects();
    if (projects.length === 0) {
      this.log(`gitlab: no projects for ${key}; set LATOILE_GITLAB_PROJECTS or LATOILE_GITLAB_GROUPS`);
      return { mergeRequests: [] };
    }

    const batches = await pooledMap(
      projects,
      this.concurrency,
      (p) => this.searchProject(key, p)
    );

    const seen = new Set<string>();
    const mergeRequests: MergeRequest[] = [];
    for (const batch of batches) {
      for (const mr of batch) {
        const dk = `${mr.project ?? ''}#${mr.iid}`;
        if (seen.has(dk)) continue;
        seen.add(dk);
        mergeRequests.push(mr);
      }
    }
    return { mergeRequests };
  }
}

export default GitlabHttpClient;
