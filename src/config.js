/**
 * Runtime configuration for latoile.
 *
 * All values come from environment variables so that authentication is handled
 * exclusively by the locally logged-in `acli` / `glab` sessions. No tokens are
 * ever read from, or stored in, the repository.
 */

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listFromEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  /** HTTP port for the live backend. */
  port: intFromEnv('PORT', 3000),

  /** Maximum traversal depth from the entry-point Jira issue. */
  maxDepth: intFromEnv('LATOILE_MAX_DEPTH', 2),

  /** Hard cap on the number of Jira nodes fetched in a single run. */
  maxNodes: intFromEnv('LATOILE_MAX_NODES', 100),

  /** Milliseconds to wait between CLI invocations (basic rate limiting). */
  cliDelayMs: intFromEnv('LATOILE_CLI_DELAY_MS', 0),

  /** Number of retries for a transient CLI failure. */
  cliRetries: intFromEnv('LATOILE_CLI_RETRIES', 2),

  /** Per CLI-call timeout in milliseconds. */
  cliTimeoutMs: intFromEnv('LATOILE_CLI_TIMEOUT_MS', 30000),

  /** Binaries (overridable for testing / non-standard installs). */
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
