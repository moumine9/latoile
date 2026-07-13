/**
 * JQL text search shared by the Express `/api/search` endpoint and the MCP
 * `search_issues` tool. Shells out to `acli jira workitem search`.
 */
import { config } from '../config.js';

/** Executes an acli invocation for a search; injectable for tests. */
export type SearchRunFn = (bin: string, args: string[]) => Promise<string>;

/** Shape of one row of `acli jira workitem search --json` that we consume. */
type RawSearchResult = {
  key?: string;
  fields?: {
    summary?: string;
    issuetype?: { name?: string };
  };
}

export type IssueSearchResult = {
  key: string;
  summary: string;
  type: string;
}

/**
 * Escapes a user string for interpolation inside a double-quoted JQL string
 * literal. Backslashes first, then quotes, so a trailing `\` cannot swallow
 * the closing quote. Control characters are dropped.
 */
export function escapeJqlString(value: string): string {
  return value
    .replace(/[\p{Cc}]/gu, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

async function defaultSearchRun(bin: string, args: string[]): Promise<string> {
  const { createRunner } = await import('./runner.js');
  const r = createRunner({
    delayMs: config.cliDelayMs,
    retries: config.cliRetries,
    timeoutMs: config.cliTimeoutMs,
  });
  return r(bin, args);
}

export type SearchIssuesOptions = {
  limit?: number;
  searchRun?: SearchRunFn;
}

/** Full-text Jira search (summary + text), newest-updated first. */
export async function searchIssues(
  query: string,
  options: SearchIssuesOptions = {}
): Promise<IssueSearchResult[]> {
  const { limit = 8, searchRun = defaultSearchRun } = options;
  const escaped = escapeJqlString(query.trim());
  if (!escaped) return [];
  const jql = `(text ~ "${escaped}" OR summary ~ "${escaped}") ORDER BY updated DESC`;
  const stdout = await searchRun(config.acliBin, [
    'jira', 'workitem', 'search',
    '--jql', jql,
    '--limit', String(limit),
    '--fields', 'key,summary,issuetype',
    '--json',
  ]);
  if (!stdout) return [];

  const parsed: RawSearchResult[] = JSON.parse(stdout) as RawSearchResult[];
  const results = Array.isArray(parsed) ? parsed : [];
  return results
    .filter((r): r is RawSearchResult & { key: string } => typeof r.key === 'string')
    .map((r) => ({
      key: r.key,
      summary: r.fields?.summary || '',
      type: r.fields?.issuetype?.name || '',
    }));
}
