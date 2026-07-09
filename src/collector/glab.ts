import { isJiraKey } from './jiraKeys.js';
import type { Commit, GitlabContext, LogFn, MergeRequest, RunFn } from '../types.js';

/* -------------------------------------------------------------------------- */
/* Raw glab / GitLab REST payload shapes (exported for the HTTP client)       */
/* -------------------------------------------------------------------------- */

export interface RawMergeRequest {
  iid?: number;
  id?: number;
  references?: { full?: string };
  project_path?: string;
  project?: { path_with_namespace?: string };
  title?: string;
  state?: string;
  source_branch?: string;
  sourceBranch?: string;
  target_branch?: string;
  targetBranch?: string;
  web_url?: string;
  webUrl?: string;
  url?: string;
  author?: { username?: string; name?: string };
}

export interface RawCommit {
  id?: string;
  sha?: string;
  short_id?: string;
  title?: string;
  message?: string;
  author_name?: string;
  author?: { name?: string };
  committer_name?: string;
  created_at?: string;
  committed_date?: string;
  authored_date?: string;
}

interface RawProject {
  id?: number;
  path_with_namespace?: string;
  name?: string;
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export interface GlabClientDeps {
  run: RunFn;
  bin?: string;
  projects?: string[];
  /** GitLab groups to enumerate projects from when `projects` is empty. */
  groups?: string[];
  /** Max simultaneous glab API calls (default 8). */
  concurrency?: number;
  log?: LogFn;
}

/**
 * Thin client around the GitLab CLI (`glab`).
 *
 * Uses `glab api` for all calls so it works outside any git repository.
 * When `projects` is set, those paths are searched directly. When `groups` is
 * set instead, the project list is resolved from the group API once per client
 * lifetime and cached. Either `projects` or `groups` must be configured;
 * otherwise a warning is logged and the client returns empty results.
 */
export class GlabClient {
  run: RunFn;
  bin: string;
  projects: string[];
  groups: string[];
  concurrency: number;
  log: LogFn;
  /** Resolved project list, cached after the first call to `resolveProjects`. */
  _cachedProjects: string[] | null;

  constructor({ run, bin = 'glab', projects = [], groups = [], concurrency = 8, log = () => {} }: GlabClientDeps) {
    if (typeof run !== 'function') {
      throw new TypeError('GlabClient requires a `run` function');
    }
    this.run = run;
    this.bin = bin;
    this.projects = Array.isArray(projects) ? projects : [];
    this.groups = Array.isArray(groups) ? groups : [];
    this.concurrency = concurrency > 0 ? concurrency : 8;
    this.log = log;
    this._cachedProjects = null;
  }

  /**
   * Project-scoped MR search via `glab api`. Does not require a git repository
   * to be present in the working directory.
   */
  mrListArgs(key: string, project: string): string[] {
    const encoded = encodeURIComponent(project);
    return [
      'api',
      `projects/${encoded}/merge_requests?search=${encodeURIComponent(key)}&in=title&state=all&per_page=50`,
    ];
  }

  /** Enumerates one page of projects in a GitLab group. */
  groupProjectsArgs(group: string, page = 1): string[] {
    const encoded = encodeURIComponent(group);
    return [
      'api',
      `groups/${encoded}/projects?include_subgroups=true&archived=false&per_page=100&simple=true&page=${page}`,
    ];
  }

  /** `glab api` args to list commits of a merge request. */
  mrCommitsArgs(projectPath: string, iid: number): string[] {
    const encoded = encodeURIComponent(projectPath);
    return ['api', `projects/${encoded}/merge_requests/${iid}/commits`];
  }

  /**
   * Returns the full list of projects to search. Uses `this.projects` when set;
   * otherwise resolves from `this.groups` (result is cached for the client's
   * lifetime).
   */
  async resolveProjects(): Promise<string[]> {
    if (this.projects.length > 0) return this.projects;
    if (this._cachedProjects !== null) return this._cachedProjects;
    if (this.groups.length === 0) {
      this._cachedProjects = [];
      return [];
    }
    const all: string[] = [];
    for (const group of this.groups) {
      const projects = await this.fetchGroupProjects(group);
      all.push(...projects);
    }
    this._cachedProjects = [...new Set(all)];
    return this._cachedProjects;
  }

  /** Paginates through a group's project list and returns all project paths. */
  async fetchGroupProjects(group: string): Promise<string[]> {
    const projects: string[] = [];
    let page = 1;
    for (;;) {
      let data: RawProject[];
      try {
        const stdout = await this.run(this.bin, this.groupProjectsArgs(group, page));
        const parsed: unknown = stdout ? JSON.parse(stdout) : [];
        data = Array.isArray(parsed) ? (parsed as RawProject[]) : [];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`glab group projects failed for ${group}: ${message}`);
        break;
      }
      for (const p of data) {
        if (p.path_with_namespace) projects.push(p.path_with_namespace);
      }
      if (data.length < 100) break;
      page++;
    }
    return projects;
  }

  /**
   * Searches MRs for a Jira key within a single project, then fetches commits
   * for each MR found.
   */
  async searchProject(key: string, project: string): Promise<MergeRequest[]> {
    let list: RawMergeRequest[];
    try {
      const stdout = await this.run(this.bin, this.mrListArgs(key, project));
      const parsed: unknown = stdout ? JSON.parse(stdout) : [];
      list = Array.isArray(parsed) ? (parsed as RawMergeRequest[]) : [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`glab mr search failed for ${key} in ${project}: ${message}`);
      return [];
    }
    const mergeRequests: MergeRequest[] = [];
    for (const item of list) {
      const mr = normalizeMergeRequest(item, project);
      if (!mr) continue;
      mr.commits = await this.fetchCommits(mr).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`glab commits failed for MR ${project}!${mr.iid}: ${message}`);
        return [];
      });
      mergeRequests.push(mr);
    }
    return mergeRequests;
  }

  /**
   * Resolves all GitLab context for a single Jira key. Fans out across all
   * configured projects with a concurrency cap and deduplicates by project + MR iid.
   * Never throws: on failure it logs and returns whatever partial data it has.
   */
  async fetchForKey(key: string): Promise<GitlabContext> {
    if (!isJiraKey(key)) return { mergeRequests: [] };

    const projects = await this.resolveProjects();
    if (projects.length === 0) {
      this.log(
        `glab: no projects configured for ${key}; set LATOILE_GITLAB_PROJECTS or LATOILE_GITLAB_GROUPS`
      );
      return { mergeRequests: [] };
    }

    const batches = await pooledMap(projects, this.concurrency, (p) => this.searchProject(key, p));

    const seen = new Set<string>();
    const mergeRequests: MergeRequest[] = [];
    for (const batch of batches) {
      for (const mr of batch) {
        const dedupeKey = `${mr.project ?? ''}#${mr.iid}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        mergeRequests.push(mr);
      }
    }
    return { mergeRequests };
  }

  /**
   * Best-effort commit resolution for a normalized MR. Returns an empty array
   * when project path or iid is unavailable.
   */
  async fetchCommits(mr: MergeRequest): Promise<Commit[]> {
    const projectPath = mr.project;
    if (!projectPath || !mr.iid) return [];
    const stdout = await this.run(this.bin, this.mrCommitsArgs(projectPath, mr.iid));
    const parsed: unknown = stdout ? JSON.parse(stdout) : [];
    const list = Array.isArray(parsed) ? (parsed as RawCommit[]) : [];
    const out: Commit[] = [];
    for (const item of list) {
      const commit = normalizeCommit(item);
      if (commit) out.push(commit);
    }
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* Concurrency helper                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Maps `items` through `fn` with at most `limit` concurrent executions.
 * Preserves input order in the output array.
 */
export async function pooledMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/* -------------------------------------------------------------------------- */
/* Normalization helpers                                                       */
/* -------------------------------------------------------------------------- */

function firstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function normalizeMergeRequest(
  item: RawMergeRequest | null | undefined,
  fallbackProject: string | undefined
): MergeRequest | null {
  if (!item || typeof item !== 'object') return null;
  const iid = firstDefined(item.iid, item.id);
  if (iid === undefined) return null;

  const project = firstDefined(
    item.references?.full?.split('!')[0],
    item.project_path,
    item.project?.path_with_namespace,
    fallbackProject
  );

  return {
    iid,
    project: typeof project === 'string' ? project : undefined,
    title: item.title ?? '',
    state: item.state ?? 'unknown',
    sourceBranch: firstDefined(item.source_branch, item.sourceBranch),
    targetBranch: firstDefined(item.target_branch, item.targetBranch),
    url: firstDefined(item.web_url, item.webUrl, item.url),
    author: firstDefined(item.author?.username, item.author?.name),
    commits: [],
  };
}

export function normalizeCommit(item: RawCommit | null | undefined): Commit | null {
  if (!item || typeof item !== 'object') return null;
  const sha = firstDefined(item.id, item.sha, item.short_id);
  if (!sha) return null;
  return {
    sha,
    shortSha: firstDefined(item.short_id, String(sha).slice(0, 8)) ?? String(sha).slice(0, 8),
    title: firstDefined(item.title, item.message) ?? '',
    author: firstDefined(item.author_name, item.author?.name, item.committer_name),
    timestamp: firstDefined(item.created_at, item.committed_date, item.authored_date),
  };
}

export default GlabClient;
