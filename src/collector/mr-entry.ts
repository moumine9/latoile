/**
 * GitLab merge-request URL as a context entry point.
 *
 * latoile's traversal starts from a Jira key; this module bridges the reverse
 * direction: given an MR link, fetch the MR and extract the Jira key from its
 * source branch (team convention: `fix/PV2-XXXXX-...`), title, or description,
 * then the normal traversal can run from that key.
 */
import { extractJiraKeys } from './jiraKeys.js';
import type { RawMergeRequest } from './glab.js';
import type { LogFn } from '../types.js';

export interface ParsedMrUrl {
  host: string;
  project: string;
  iid: number;
}

/**
 * Parses a GitLab MR URL of the form
 * `https://<host>/<group>/<project>/-/merge_requests/<iid>[...]`.
 * Returns `null` for anything else.
 */
export function parseMrUrl(url: string): ParsedMrUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const match = parsed.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/|$)/);
  if (!match?.[1] || !match[2]) return null;
  const iid = Number.parseInt(match[2], 10);
  if (!Number.isFinite(iid) || iid <= 0) return null;
  return { host: parsed.hostname, project: match[1], iid };
}

/** Minimal GitLab API contract needed to resolve an MR — matches GitlabHttpClient. */
export interface MrApiSource {
  apiGet<T>(path: string): Promise<T>;
}

export interface ResolvedMrEntry {
  /** The Jira key extracted from the MR. */
  key: string;
  /** Which MR field the key was found in. */
  foundIn: 'source_branch' | 'title' | 'description';
  mrTitle: string;
  mrProject: string;
  mrIid: number;
}

/**
 * Fetches the MR and extracts the first Jira key, checking the source branch
 * first (most reliable per team convention), then the title, then the
 * description. Throws with a clear message when no key is found.
 */
export async function resolveJiraKeyFromMr(
  parsed: ParsedMrUrl,
  source: MrApiSource,
  log: LogFn = () => {}
): Promise<ResolvedMrEntry> {
  log(`Resolving MR !${parsed.iid} in ${parsed.project}...`);
  const raw = await source.apiGet<RawMergeRequest & { description?: string }>(
    `projects/${encodeURIComponent(parsed.project)}/merge_requests/${parsed.iid}`
  );

  const fields: Array<[ResolvedMrEntry['foundIn'], string | undefined]> = [
    ['source_branch', raw.source_branch ?? raw.sourceBranch],
    ['title', raw.title],
    ['description', raw.description],
  ];
  for (const [foundIn, text] of fields) {
    // Branch names are often lowercase (fix/pv2-123-...); uppercase before
    // matching since the Jira key regex is uppercase-only.
    const keys = extractJiraKeys(text?.toUpperCase());
    const key = keys[0];
    if (key) {
      log(`Resolved MR !${parsed.iid} to ${key} (from ${foundIn})`);
      return {
        key,
        foundIn,
        mrTitle: raw.title || '',
        mrProject: parsed.project,
        mrIid: parsed.iid,
      };
    }
  }
  throw new Error(
    `No Jira key found in MR !${parsed.iid} (${parsed.project}): checked source branch, title, and description.`
  );
}
