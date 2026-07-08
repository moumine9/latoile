import { isJiraKey } from './jiraKeys.js';
import type { Commit, GitlabContext, LogFn, MergeRequest, RunFn } from '../types.js';

/* -------------------------------------------------------------------------- */
/* Raw glab payload shapes                                                     */
/* -------------------------------------------------------------------------- */

interface RawMergeRequest {
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

interface RawCommit {
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

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export interface GlabClientDeps {
  run: RunFn;
  bin?: string;
  projects?: string[];
  log?: LogFn;
}

/**
 * Thin client around the GitLab CLI (`glab`).
 *
 * Given a Jira key, it searches merge requests that reference the key (in title,
 * description or branch name), then best-effort resolves each MR's branch and
 * commits. All output is normalized into latoile's internal GitLab shape.
 */
export class GlabClient {
  run: RunFn;
  bin: string;
  projects: string[];
  log: LogFn;

  constructor({ run, bin = 'glab', projects = [], log = () => {} }: GlabClientDeps) {
    if (typeof run !== 'function') {
      throw new TypeError('GlabClient requires a `run` function');
    }
    this.run = run;
    this.bin = bin;
    this.projects = Array.isArray(projects) ? projects : [];
    this.log = log;
  }

  /** Merge-request search argument vector for a given key/project. */
  mrListArgs(key: string, project: string | undefined): string[] {
    const args = ['mr', 'list', '--search', key, '--output', 'json'];
    if (project) args.push('--repo', project);
    return args;
  }

  /** `glab api` args to list commits of a merge request. */
  mrCommitsArgs(projectPath: string, iid: number): string[] {
    const encoded = encodeURIComponent(projectPath);
    return ['api', `projects/${encoded}/merge_requests/${iid}/commits`];
  }

  /**
   * Resolves all GitLab context for a single Jira key across configured
   * projects. Never throws: on failure it logs and returns whatever it has.
   */
  async fetchForKey(key: string): Promise<GitlabContext> {
    if (!isJiraKey(key)) return { mergeRequests: [] };
    const scopes: Array<string | undefined> = this.projects.length ? this.projects : [undefined];
    const mergeRequests: MergeRequest[] = [];
    const seen = new Set<string>();

    for (const project of scopes) {
      let list: RawMergeRequest[];
      try {
        const stdout = await this.run(this.bin, this.mrListArgs(key, project));
        const data = stdout ? (JSON.parse(stdout) as RawMergeRequest[]) : [];
        list = Array.isArray(data) ? data : [];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`glab mr search failed for ${key}${project ? ` in ${project}` : ''}: ${message}`);
        continue;
      }

      for (const item of list) {
        const mr = normalizeMergeRequest(item, project);
        if (!mr) continue;
        const dedupeKey = `${mr.project || project || ''}#${mr.iid}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        mr.commits = await this.fetchCommits(mr).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log(`glab commits failed for MR ${dedupeKey}: ${message}`);
          return [];
        });
        mergeRequests.push(mr);
      }
    }

    return { mergeRequests };
  }

  /**
   * Best-effort commit resolution for a normalized MR. Requires a project path
   * and iid; returns an empty array when either is unavailable.
   */
  async fetchCommits(mr: MergeRequest): Promise<Commit[]> {
    const projectPath = mr.project;
    if (!projectPath || !mr.iid) return [];
    const stdout = await this.run(this.bin, this.mrCommitsArgs(projectPath, mr.iid));
    const data = stdout ? (JSON.parse(stdout) as RawCommit[]) : [];
    const list = Array.isArray(data) ? data : [];
    const out: Commit[] = [];
    for (const item of list) {
      const commit = normalizeCommit(item);
      if (commit) out.push(commit);
    }
    return out;
  }
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
