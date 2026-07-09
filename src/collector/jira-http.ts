/**
 * Jira HTTP client — uses fetch() + Atlassian API token instead of shelling
 * out to `acli` for every issue fetch.
 *
 * ~15× faster than spawning `acli` per request (no binary startup, persistent
 * connection). Requires three env vars (see README / .env):
 *   LATOILE_JIRA_URL    e.g. https://your-org.atlassian.net
 *   LATOILE_JIRA_EMAIL  your Atlassian account email
 *   LATOILE_JIRA_TOKEN  Atlassian API token (not your password)
 *                       Generate at: https://id.atlassian.com/manage-profile/security/api-tokens
 *
 * Falls back to AcliClient in pipeline.ts when any of these are absent.
 */
import { normalizeIssue, type RawJiraIssue } from './acli.js';
import type { FetchFn } from './gitlab-http.js';
import type { LogFn, NormalizedIssue } from '../types.js';

export interface JiraHttpClientDeps {
  /** Base URL of the Jira Cloud instance, e.g. https://your-org.atlassian.net */
  baseUrl: string;
  email: string;
  token: string;
  /** Fetch implementation — injectable for tests. */
  fetch?: FetchFn;
  log?: LogFn;
}

/**
 * Jira Cloud REST API v3 client.
 *
 * Implements the same `IssueSource` contract as `AcliClient` so it can be
 * dropped into the traversal without other changes.
 */
export class JiraHttpClient {
  baseUrl: string;
  authHeader: string;
  fetch: FetchFn;
  log: LogFn;

  constructor({
    baseUrl,
    email,
    token,
    fetch: fetchImpl = globalThis.fetch,
    log = () => {},
  }: JiraHttpClientDeps) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    this.fetch = fetchImpl;
    this.log = log;
  }

  /** Authenticated GET against the Jira REST API v3. */
  async apiGet<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/rest/api/3/${path}`;
    const resp = await this.fetch(url, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `Jira API ${resp.status} ${resp.statusText} — ${path}${body ? `: ${body.slice(0, 200)}` : ''}`
      );
    }
    return resp.json() as Promise<T>;
  }

  /**
   * Fetches a single Jira issue and its remote links in parallel, then
   * normalizes the result into latoile's internal shape.
   * Returns `null` when the issue cannot be retrieved (permission / not found).
   */
  async fetchIssue(key: string): Promise<NormalizedIssue | null> {
    try {
      const [issue, remoteLinks] = await Promise.all([
        this.apiGet<RawJiraIssue>(`issue/${key}?fields=*all`),
        this.apiGet<RawJiraIssue['remoteLinks']>(`issue/${key}/remotelink`).catch(
          (): RawJiraIssue['remoteLinks'] => []
        ),
      ]);

      if (Array.isArray(remoteLinks) && remoteLinks.length > 0) {
        issue.remoteLinks = remoteLinks;
      }

      return normalizeIssue(issue, key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`skip ${key}: ${message}`);
      return null;
    }
  }
}

export default JiraHttpClient;
