import { isJiraKey } from './jiraKeys.js';

/**
 * Thin client around the GitLab CLI (`glab`).
 *
 * Given a Jira key, it searches merge requests that reference the key (in title,
 * description or branch name), then best-effort resolves each MR's branch and
 * commits. All output is normalized into latoile's internal GitLab shape.
 */
export class GlabClient {
  /**
   * @param {object} deps
   * @param {(bin: string, args: string[]) => Promise<string>} deps.run
   * @param {string} [deps.bin]
   * @param {string[]} [deps.projects] explicit projects to search (group/path)
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ run, bin = 'glab', projects = [], log = () => {} }) {
    if (typeof run !== 'function') {
      throw new TypeError('GlabClient requires a `run` function');
    }
    this.run = run;
    this.bin = bin;
    this.projects = Array.isArray(projects) ? projects : [];
    this.log = log;
  }

  /**
   * Merge-request search argument vector for a given key/project.
   * @param {string} key
   * @param {string|undefined} project
   */
  mrListArgs(key, project) {
    const args = ['mr', 'list', '--search', key, '--output', 'json'];
    if (project) args.push('--repo', project);
    return args;
  }

  /** `glab api` args to list commits of a merge request. */
  mrCommitsArgs(projectPath, iid) {
    const encoded = encodeURIComponent(projectPath);
    return ['api', `projects/${encoded}/merge_requests/${iid}/commits`];
  }

  /**
   * Resolves all GitLab context for a single Jira key across configured
   * projects. Never throws: on failure it logs and returns whatever it has.
   *
   * @param {string} key
   * @returns {Promise<{ mergeRequests: object[] }>}
   */
  async fetchForKey(key) {
    if (!isJiraKey(key)) return { mergeRequests: [] };
    const scopes = this.projects.length ? this.projects : [undefined];
    const mergeRequests = [];
    const seen = new Set();

    for (const project of scopes) {
      let raw;
      try {
        const stdout = await this.run(this.bin, this.mrListArgs(key, project));
        raw = stdout ? JSON.parse(stdout) : [];
      } catch (err) {
        this.log(`glab mr search failed for ${key}${project ? ` in ${project}` : ''}: ${err.message}`);
        continue;
      }

      const list = Array.isArray(raw) ? raw : [];
      for (const item of list) {
        const mr = normalizeMergeRequest(item, project);
        if (!mr) continue;
        const dedupeKey = `${mr.project || project || ''}#${mr.iid}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        mr.commits = await this.fetchCommits(mr).catch((err) => {
          this.log(`glab commits failed for MR ${dedupeKey}: ${err.message}`);
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
   * @param {object} mr
   * @returns {Promise<object[]>}
   */
  async fetchCommits(mr) {
    const projectPath = mr.project;
    if (!projectPath || !mr.iid) return [];
    const stdout = await this.run(this.bin, this.mrCommitsArgs(projectPath, mr.iid));
    const raw = stdout ? JSON.parse(stdout) : [];
    return (Array.isArray(raw) ? raw : []).map(normalizeCommit).filter(Boolean);
  }
}

/* -------------------------------------------------------------------------- */
/* Normalization helpers                                                       */
/* -------------------------------------------------------------------------- */

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function normalizeMergeRequest(item, fallbackProject) {
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
    title: firstDefined(item.title, ''),
    state: firstDefined(item.state, 'unknown'),
    sourceBranch: firstDefined(item.source_branch, item.sourceBranch),
    targetBranch: firstDefined(item.target_branch, item.targetBranch),
    url: firstDefined(item.web_url, item.webUrl, item.url),
    author: firstDefined(item.author?.username, item.author?.name),
    commits: [],
  };
}

export function normalizeCommit(item) {
  if (!item || typeof item !== 'object') return null;
  const sha = firstDefined(item.id, item.sha, item.short_id);
  if (!sha) return null;
  return {
    sha,
    shortSha: firstDefined(item.short_id, String(sha).slice(0, 8)),
    title: firstDefined(item.title, item.message, ''),
    author: firstDefined(item.author_name, item.author?.name, item.committer_name),
    timestamp: firstDefined(item.created_at, item.committed_date, item.authored_date),
  };
}

export default GlabClient;
