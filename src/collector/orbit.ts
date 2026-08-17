/**
 * GitLab Orbit Local client — enriches the context payload with a "code
 * neighborhood" read from a local Orbit DuckDB graph (`~/.orbit/graph.duckdb`).
 *
 * It shells out to the `orbit` CLI (`orbit sql -F json`) rather than opening
 * DuckDB directly, staying consistent with the acli/glab process-spawning
 * pattern and avoiding a native DuckDB dependency. Read-only.
 *
 * Correlation: latoile knows a GitLab project path (e.g.
 * `familiprix/priorx/Prescription`) and the MR's changed files. Orbit's
 * `project_id` is a synthetic hash (NOT GitLab's id), so repos are matched by
 * their last path segment, lowercased, against `_orbit_manifest.repo_path`. MR
 * changed-file paths are repo-root-relative and match `gl_definition.file_path`
 * directly. See PLAN-ORBIT.md.
 *
 * Everything here is best-effort and branch-approximate — see the caveats on
 * `ContextCodeNeighborhood`.
 */
import type { ContextCodeDefinition, ContextCodeNeighborhood, LogFn, RunFn } from '../types.js';

/** Minimal contract used by the enrichment step — injectable for tests. */
export type OrbitSource = {
  resolveRepo(repoName: string): Promise<OrbitRepo | null>;
  definitionsForFiles(projectId: string, files: string[], maxDefinitions: number): Promise<OrbitFileDefs>;
}

/** A repo as recorded in Orbit's manifest. `projectId` is kept as a string (BIGINT > 2^53). */
export type OrbitRepo = {
  projectId: string;
  repoPath: string;
  branch: string | undefined;
  commitSha: string | undefined;
}

/** Definitions found in a set of changed files, plus how many files actually matched. */
export type OrbitFileDefs = {
  filesMatched: number;
  definitions: ContextCodeDefinition[];
}

export type OrbitClientDeps = {
  run: RunFn;
  bin?: string;
  /** Override the DuckDB path; empty = the CLI's own default (~/.orbit/graph.duckdb). */
  dbPath?: string;
  log?: LogFn;
}

/** Escapes a value for embedding inside a single-quoted SQL string literal. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Last path segment of a `/`-separated path, lowercased (the repo-match key). */
export function repoNameFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

type ManifestRow = { project_id?: string; repo_path?: string; branch?: string; commit_sha?: string };
type DefinitionRow = { file?: string; name?: string; kind?: string; start_line?: number };

export class OrbitClient implements OrbitSource {
  run: RunFn;
  bin: string;
  dbPath: string;
  log: LogFn;
  private repoCache = new Map<string, OrbitRepo | null>();

  constructor({ run, bin = 'orbit', dbPath = '', log = () => {} }: OrbitClientDeps) {
    if (typeof run !== 'function') throw new TypeError('OrbitClient requires a `run` function');
    this.run = run;
    this.bin = bin;
    this.dbPath = dbPath;
    this.log = log;
  }

  /** Runs a read-only SQL query. `[]` means genuinely no rows; throws on CLI/parse failure. */
  async sql<T>(query: string): Promise<T[]> {
    const args = ['sql', query, '-F', 'json'];
    if (this.dbPath) args.push('--db', this.dbPath);
    const stdout = await this.run(this.bin, args);
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }

  /**
   * Resolves a GitLab repo name (last path segment, lowercased) to its Orbit
   * manifest entry, or `null` when the repo isn't indexed locally. Cached per
   * client, including negative results.
   */
  async resolveRepo(repoName: string): Promise<OrbitRepo | null> {
    const key = repoName.toLowerCase();
    const cached = this.repoCache.get(key);
    if (cached !== undefined) return cached;

    // repo_path uses OS separators (backslash on Windows); normalize to '/'
    // before taking the last segment so the match is portable.
    // A repo indexed from multiple branches yields multiple rows here; order
    // deterministically (no indexed-at column to prefer "latest") and log it.
    const rows = await this.sql<ManifestRow>(
      "SELECT CAST(project_id AS VARCHAR) AS project_id, repo_path, branch, commit_sha " +
        "FROM _orbit_manifest " +
        `WHERE lower(list_last(string_split(replace(repo_path, '\\', '/'), '/'))) = ${sqlString(key)} ` +
        'ORDER BY branch, commit_sha'
    );
    if (rows.length > 1) {
      const branches = [...new Set(rows.map((r) => r.branch ?? '(unknown)'))];
      this.log(
        `orbit: "${repoName}" indexed from ${rows.length} manifest entries (branches: ${branches.join(', ')}); using "${rows[0]?.branch ?? '(unknown)'}"`
      );
    }
    const row = rows[0];
    const repo: OrbitRepo | null =
      row && typeof row.project_id === 'string' && /^\d+$/.test(row.project_id)
        ? { projectId: row.project_id, repoPath: row.repo_path ?? '', branch: row.branch, commitSha: row.commit_sha }
        : null;
    this.repoCache.set(key, repo);
    return repo;
  }

  /**
   * Returns the definitions living in `files` for a given project, plus how many
   * of those files had at least one definition on the indexed branch. Definitions
   * are capped at `maxDefinitions`; `filesMatched` reflects the full match set.
   */
  async definitionsForFiles(projectId: string, files: string[], maxDefinitions: number): Promise<OrbitFileDefs> {
    if (!/^\d+$/.test(projectId) || files.length === 0) return { filesMatched: 0, definitions: [] };
    const inList = files.map(sqlString).join(', ');
    const rows = await this.sql<DefinitionRow>(
      'SELECT file_path AS file, name, definition_type AS kind, start_line ' +
        `FROM gl_definition WHERE project_id = ${projectId} AND file_path IN (${inList}) ` +
        'ORDER BY file_path, start_line'
    );
    const matchedFiles = new Set<string>();
    const definitions: ContextCodeDefinition[] = [];
    for (const r of rows) {
      if (typeof r.file === 'string') matchedFiles.add(r.file);
      if (definitions.length < maxDefinitions) {
        definitions.push({
          name: r.name ?? '',
          kind: r.kind ?? '',
          file: r.file ?? '',
          start_line: typeof r.start_line === 'number' ? r.start_line : undefined,
        });
      }
    }
    return { filesMatched: matchedFiles.size, definitions };
  }
}

/* -------------------------------------------------------------------------- */
/* Enrichment                                                                  */
/* -------------------------------------------------------------------------- */

/** The subset of a resolved issue node the enrichment needs. */
export type IssueForCode = {
  key: string;
  mergeRequests: Array<{ project: string | undefined; changedFiles?: string[] }>;
}

/**
 * Groups an issue's MR changed files by GitLab project path. Only MRs that
 * carry `changedFiles` (i.e. `LATOILE_GITLAB_FETCH_FILES=1` was on) contribute.
 */
function changedFilesByRepo(issue: IssueForCode): Map<string, Set<string>> {
  const byRepo = new Map<string, Set<string>>();
  for (const mr of issue.mergeRequests) {
    if (!mr.project || !mr.changedFiles?.length) continue;
    let set = byRepo.get(mr.project);
    if (!set) {
      set = new Set<string>();
      byRepo.set(mr.project, set);
    }
    for (const f of mr.changedFiles) set.add(f);
  }
  return byRepo;
}

/**
 * Builds the code-neighborhood list for one issue from its MR changed files.
 * Returns `undefined` when the issue has no changed files to map (so the `code`
 * field stays absent rather than an empty array).
 */
export async function codeNeighborhoodsForIssue(
  issue: IssueForCode,
  orbit: OrbitSource,
  maxDefinitions: number,
  log: LogFn = () => {}
): Promise<ContextCodeNeighborhood[] | undefined> {
  const byRepo = changedFilesByRepo(issue);
  if (byRepo.size === 0) return undefined;

  const out: ContextCodeNeighborhood[] = [];
  for (const [repository, fileSet] of byRepo) {
    const files = [...fileSet];
    try {
      const repo = await orbit.resolveRepo(repoNameFromPath(repository));
      if (!repo) {
        out.push({
          repository,
          indexed: false,
          branch: undefined,
          commit_sha: undefined,
          files_changed: files.length,
          files_matched: 0,
          definitions: [],
        });
        continue;
      }
      const { filesMatched, definitions } = await orbit.definitionsForFiles(repo.projectId, files, maxDefinitions);
      out.push({
        repository,
        indexed: true,
        branch: repo.branch,
        commit_sha: repo.commitSha,
        files_changed: files.length,
        files_matched: filesMatched,
        definitions,
      });
    } catch (err) {
      // A real orbit CLI failure, not "no rows" — skip this repo rather than
      // reporting it as unindexed or falsely matched.
      log(`orbit: skipping "${repository}" (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return out;
}

export default OrbitClient;
