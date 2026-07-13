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

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

/** Injectable fetch function — matches the global `fetch` signature. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

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
  fetch: FetchFn;
  log: LogFn;
  _cachedProjects: string[] | null;

  constructor({
    token,
    host = 'gitlab.com',
    projects = [],
    groups = [],
    activeDays = 90,
    concurrency = 20,
    fetch: fetchImpl = globalThis.fetch,
    log = () => {},
  }: GitlabHttpClientDeps) {
    this.token = token ?? readGlabToken(host) ?? '';
    this.baseUrl = `https://${host}/api/v4`;
    this.projects = Array.isArray(projects) ? projects : [];
    this.groups = Array.isArray(groups) ? groups : [];
    this.activeDays = activeDays > 0 ? activeDays : 90;
    this.concurrency = concurrency > 0 ? concurrency : 20;
    this.fetch = fetchImpl;
    this.log = log;
    this._cachedProjects = null;
  }

  /** Makes an authenticated GET request and returns the parsed JSON body. */
  async apiGet<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/${path}`;
    const resp = await this.fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`GitLab API ${resp.status} ${resp.statusText} — ${path}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return resp.json() as Promise<T>;
  }

  /**
   * Fetches all projects in a GitLab group (including subgroups), filtered to
   * those with activity within `this.activeDays`. Sorted by recency so early
   * pages are the most relevant. Pagination stops as soon as all items on a
   * page are older than the cutoff.
   */
  async fetchGroupProjects(group: string): Promise<string[]> {
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
        data = await this.apiGet<RawProject[]>(path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`gitlab: group project list failed for ${group}: ${msg}`);
        break;
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

    return results;
  }

  /** Resolves the project list from `projects` or `groups` (cached). */
  async resolveProjects(): Promise<string[]> {
    if (this.projects.length > 0) return this.projects;
    if (this._cachedProjects !== null) return this._cachedProjects;
    if (this.groups.length === 0) {
      this._cachedProjects = [];
      return [];
    }

    const all: string[] = [];
    for (const group of this.groups) {
      const ps = await this.fetchGroupProjects(group);
      all.push(...ps);
    }
    this._cachedProjects = [...new Set(all)];
    this.log(`gitlab: ${this._cachedProjects.length} active projects resolved from ${this.groups.join(', ')}`);
    return this._cachedProjects;
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
