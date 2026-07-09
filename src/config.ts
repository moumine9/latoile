/**
 * Runtime configuration for latoile.
 *
 * All values come from environment variables so that authentication is handled
 * exclusively by the locally logged-in `acli` / `glab` sessions. No tokens are
 * ever read from, or stored in, the repository.
 *
 * A `.env` file in the current working directory is loaded automatically on
 * startup (no extra dependency — plain KEY=value parsing).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads a `.env` file from the CWD into `process.env`. Only sets variables
 * that are not already present in the environment so shell exports always win.
 * Supports `KEY=value`, `KEY="value"`, and `KEY='value'`; ignores blank lines
 * and lines starting with `#`.
 */
function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

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
  /** GitLab groups to enumerate projects from (resolved once per run). */
  gitlabGroups: string[];
  /** Max simultaneous glab API calls when searching across many projects. */
  gitlabConcurrency: number;
  /** Projects inactive for longer than this many days are skipped in group scans. */
  gitlabActiveDays: number;
  /** Jira Cloud base URL for the direct HTTP client (e.g. https://org.atlassian.net). */
  jiraUrl: string;
  /** Atlassian account email for Jira API basic auth. */
  jiraEmail: string;
  /** Atlassian API token for Jira API basic auth. */
  jiraToken: string;
  /** Base URL for Jira (e.g. https://your-domain.atlassian.net) used to construct node links */
  jiraBaseUrl: string;
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
  gitlabGroups: listFromEnv('LATOILE_GITLAB_GROUPS'),
  /** How many projects to search in parallel. Prevents spawning hundreds of glab processes at once. */
  gitlabConcurrency: intFromEnv('LATOILE_GITLAB_CONCURRENCY', 8),
  gitlabActiveDays: intFromEnv('LATOILE_GITLAB_ACTIVE_DAYS', 90),
  jiraUrl: process.env['LATOILE_JIRA_URL'] || '',
  jiraEmail: process.env['LATOILE_JIRA_EMAIL'] || '',
  jiraToken: process.env['LATOILE_JIRA_TOKEN'] || '',
  jiraBaseUrl: process.env.LATOILE_JIRA_BASE_URL || '',
};

export default config;
