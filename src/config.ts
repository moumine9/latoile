/**
 * Runtime configuration for latoile.
 *
 * All values come from environment variables so that authentication is handled
 * exclusively by the locally logged-in `acli` / `glab` sessions. No tokens are
 * ever read from, or stored in, the repository.
 */

export interface Config {
  /** HTTP port for the live backend. */
  port: number;
  /** Maximum traversal depth from the entry-point Jira issue. */
  maxDepth: number;
  /** Hard cap on the number of Jira nodes fetched in a single run. */
  maxNodes: number;
  /** Milliseconds to wait between CLI invocations (basic rate limiting). */
  cliDelayMs: number;
  /** Number of retries for a transient CLI failure. */
  cliRetries: number;
  /** Per CLI-call timeout in milliseconds. */
  cliTimeoutMs: number;
  /** Atlassian CLI binary. */
  acliBin: string;
  /** GitLab CLI binary. */
  glabBin: string;
  /** GitLab projects to search for merge requests / commits. */
  gitlabProjects: string[];
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listFromEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config: Config = {
  port: intFromEnv('PORT', 3000),
  maxDepth: intFromEnv('LATOILE_MAX_DEPTH', 2),
  maxNodes: intFromEnv('LATOILE_MAX_NODES', 100),
  cliDelayMs: intFromEnv('LATOILE_CLI_DELAY_MS', 0),
  cliRetries: intFromEnv('LATOILE_CLI_RETRIES', 2),
  cliTimeoutMs: intFromEnv('LATOILE_CLI_TIMEOUT_MS', 30000),
  acliBin: process.env.LATOILE_ACLI_BIN || 'acli',
  glabBin: process.env.LATOILE_GLAB_BIN || 'glab',

  /**
   * GitLab projects to search for merge requests / commits referencing a Jira
   * key. When empty, the collector falls back to `glab`'s default project
   * resolution (current directory / configured host).
   */
  gitlabProjects: listFromEnv('LATOILE_GITLAB_PROJECTS'),
};

export default config;
