import { extractJiraKeys, isJiraKey } from './jiraKeys.js';
import type { DocLink, IssueComment, IssueLink, LogFn, NormalizedIssue, RunFn } from '../types.js';

/* -------------------------------------------------------------------------- */
/* Raw acli / Jira REST payload shapes                                         */
/* -------------------------------------------------------------------------- */

type AdfNode = {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

type JiraDescription = string | AdfNode;

type JiraUser = {
  displayName?: string;
  name?: string;
  emailAddress?: string;
}

type JiraNamed = {
  name?: string;
}

type JiraIssueRef = {
  key?: string;
  issueKey?: string;
}

type JiraLinkType = {
  outward?: string;
  inward?: string;
  name?: string;
}

type JiraIssueLink = {
  type?: JiraLinkType | string;
  outwardIssue?: JiraIssueRef;
  inwardIssue?: JiraIssueRef;
  key?: string;
  issueKey?: string;
}

type JiraComment = {
  body?: JiraDescription;
  author?: JiraUser | string;
  created?: string;
}

type JiraRemoteLinkObject = {
  url?: string;
  title?: string;
}

type JiraRemoteLink = {
  object?: JiraRemoteLinkObject;
  url?: string;
  title?: string;
  application?: { type?: string };
  relationship?: string;
}

type JiraFields = {
  key?: string;
  summary?: string;
  title?: string;
  issuetype?: JiraNamed;
  type?: JiraNamed | string;
  status?: JiraNamed | string;
  assignee?: JiraUser | string;
  parent?: JiraIssueRef | string;
  epic?: JiraIssueRef;
  subtasks?: Array<JiraIssueRef | string>;
  issuelinks?: JiraIssueLink[];
  description?: JiraDescription;
  comment?: { comments?: Array<JiraComment | string> };
  remoteLinks?: JiraRemoteLink[];
  /**
   * Jira dev-status summary, injected by the "GitLab for Jira Cloud" plugin.
   * Contains a JSON string (possibly prefixed with `json=`) encoding per-repo
   * counts of branches, commits, and pull-requests.
   */
  customfield_10000?: string;
}

export type RawJiraIssue = {
  issueKey?: string;
  fields?: JiraFields;
  parentKey?: string;
  comments?: Array<JiraComment | string>;
  documentation?: JiraRemoteLink[];
} & JiraFields

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export type AcliClientDeps = {
  run: RunFn;
  bin?: string;
  log?: LogFn;
}

/**
 * Thin client around the Atlassian CLI (`acli`).
 *
 * The client asks `acli` to emit JSON for a single work item and normalizes it
 * into latoile's internal issue shape. The normalizer is deliberately defensive:
 * `acli` wraps the Jira REST issue representation, but exact field availability
 * varies by instance, so every accessor tolerates missing/renamed fields.
 */
export class AcliClient {
  run: RunFn;
  bin: string;
  log: LogFn;

  constructor({ run, bin = 'acli', log = () => {} }: AcliClientDeps) {
    if (typeof run !== 'function') {
      throw new TypeError('AcliClient requires a `run` function');
    }
    this.run = run;
    this.bin = bin;
    this.log = log;
  }

  /**
   * Builds the argument vector used to fetch a single work item as JSON.
   * Kept as a method so it can be overridden / inspected in tests.
   */
  viewArgs(key: string): string[] {
    // acli takes the key positionally; default fields omit issuelinks/subtasks/
    // parent/comment, so request them all.
    return ['jira', 'workitem', 'view', key, '--fields', '*all', '--json'];
  }

  /** Fetches and parses the raw JSON payload for an issue. */
  async fetchRaw(key: string): Promise<RawJiraIssue> {
    if (!isJiraKey(key)) {
      throw new Error(`Invalid Jira key: ${key}`);
    }
    const stdout = await this.run(this.bin, this.viewArgs(key));
    try {
      return JSON.parse(stdout) as RawJiraIssue;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse acli JSON for ${key}: ${message}`, { cause: err });
    }
  }

  /**
   * Fetches an issue and returns it normalized, or `null` if it cannot be
   * retrieved (e.g. permission denied / does not exist). Callers treat a null
   * as "known but unresolved" so the traversal keeps going.
   */
  async fetchIssue(key: string): Promise<NormalizedIssue | null> {
    try {
      const raw = await this.fetchRaw(key);
      return normalizeIssue(raw, key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`skip ${key}: ${message}`);
      return null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Normalization helpers                                                       */
/* -------------------------------------------------------------------------- */

/* --- Jira dev-status / GitLab hint ---------------------------------------- */

type DevInfoCount = {
  count?: number;
}

type DevInfoCachedValue = {
  summary?: {
    repository?: DevInfoCount;
    pullrequest?: DevInfoCount;
    branch?: DevInfoCount;
    commit?: DevInfoCount;
  };
}

type DevInfo = {
  cachedValue?: DevInfoCachedValue;
}

/**
 * Parses `customfield_10000` (Jira dev-status summary injected by the
 * "GitLab for Jira Cloud" plugin) and returns whether the issue has any
 * associated GitLab artifacts. Returns `undefined` when the field is absent or
 * unparseable so callers treat the result as "unknown".
 */
function parseDevInfoHint(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  try {
    const idx = raw.indexOf('json=');
    const jsonStr = idx >= 0 ? raw.slice(idx + 5) : raw;
    const data = JSON.parse(jsonStr) as DevInfo;
    const s = data?.cachedValue?.summary;
    if (!s) return undefined;
    const total =
      (s.repository?.count ?? 0) +
      (s.pullrequest?.count ?? 0) +
      (s.branch?.count ?? 0) +
      (s.commit?.count ?? 0);
    return total > 0;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */

function firstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Extracts a `name` from a `{ name }` object or returns a plain string. */
function nameOf(value: JiraNamed | string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return value.name;
}

/** Extracts a human-readable name from various Jira user shapes. */
function userName(user: JiraUser | string | undefined): string | undefined {
  if (!user) return undefined;
  if (typeof user === 'string') return user;
  return firstDefined(user.displayName, user.name, user.emailAddress);
}

/** Extracts a Jira key from a `{ key }` / `{ issueKey }` ref or a string. */
function refKey(value: JiraIssueRef | string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return firstDefined(value.key, value.issueKey);
}

/** Extracts plain text from Jira's Atlassian Document Format or a string. */
export function textFromDescription(description: JiraDescription | undefined): string {
  if (!description) return '';
  if (typeof description === 'string') return description;
  // Atlassian Document Format: walk the tree collecting text nodes.
  const parts: string[] = [];
  const walk = (node: AdfNode | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') parts.push(node.text);
    const children = Array.isArray(node.content) ? node.content : [];
    children.forEach(walk);
  };
  walk(description);
  return parts.join(' ');
}

/**
 * Normalizes a raw acli / Jira REST issue object into latoile's internal shape.
 */
export function normalizeIssue(raw: RawJiraIssue, requestedKey?: string): NormalizedIssue {
  const root: RawJiraIssue = raw && typeof raw === 'object' ? raw : {};
  const fields: JiraFields = root.fields && typeof root.fields === 'object' ? root.fields : root;

  const key = firstDefined(root.key, root.issueKey, fields.key, requestedKey);

  const type = firstDefined(nameOf(fields.issuetype), nameOf(fields.type), nameOf(root.type));

  const title = firstDefined(fields.summary, fields.title, root.summary, root.title);
  const status = firstDefined(nameOf(fields.status), nameOf(root.status));
  const assignee = userName(firstDefined(fields.assignee, root.assignee));

  const parentKey = firstDefined(
    refKey(fields.parent),
    refKey(fields.epic),
    refKey(root.parent),
    root.parentKey
  );

  const subtasks = normalizeSubtasks(firstDefined(fields.subtasks, root.subtasks));
  const links = normalizeIssueLinks(firstDefined(fields.issuelinks, root.issuelinks));

  const descriptionText = textFromDescription(firstDefined(fields.description, root.description));
  const comments = normalizeComments(firstDefined(fields.comment?.comments, root.comments));
  const documentation = normalizeRemoteLinks(
    firstDefined(root.remoteLinks, fields.remoteLinks, root.documentation)
  );

  const mentionText = [descriptionText, ...comments.map((c) => c.body)].join('\n');
  const mentions = extractJiraKeys(mentionText).filter((k) => k !== key);

  const hasGitlabData = parseDevInfoHint(firstDefined(fields.customfield_10000));

  return {
    key: typeof key === 'string' ? key : requestedKey,
    type,
    title,
    status,
    assignee,
    parentKey: typeof parentKey === 'string' ? parentKey : undefined,
    subtasks,
    links,
    mentions,
    documentation,
    description: descriptionText,
    comments,
    hasGitlabData,
  };
}

function normalizeSubtasks(subtasks: Array<JiraIssueRef | string> | undefined): string[] {
  if (!Array.isArray(subtasks)) return [];
  return subtasks
    .map((st) => (typeof st === 'string' ? st : firstDefined(st.key, st.issueKey)))
    .filter(isJiraKey);
}

function normalizeComments(comments: Array<JiraComment | string> | undefined): IssueComment[] {
  if (!Array.isArray(comments)) return [];
  const out: IssueComment[] = [];
  for (const c of comments) {
    if (typeof c === 'string') {
      if (c) out.push({ author: '', created: '', body: c });
      continue;
    }
    const body = textFromDescription(c.body);
    if (!body) continue;
    out.push({ author: userName(c.author) ?? '', created: c.created ?? '', body });
  }
  return out;
}

/**
 * Normalizes Jira issue links into `{ key, type, direction }` records.
 * A link can point to an inward or outward issue depending on relationship.
 */
function normalizeIssueLinks(issuelinks: JiraIssueLink[] | undefined): IssueLink[] {
  if (!Array.isArray(issuelinks)) return [];
  const out: IssueLink[] = [];
  const linkTypeField = (
    type: JiraLinkType | string | undefined,
    direction: 'outward' | 'inward'
  ): string | undefined => {
    if (type === undefined) return undefined;
    if (typeof type === 'string') return type;
    return firstDefined(type[direction], type.name);
  };

  for (const link of issuelinks) {
    if (!link || typeof link !== 'object') continue;
    if (link.outwardIssue) {
      const key = firstDefined(link.outwardIssue.key, link.outwardIssue.issueKey);
      if (isJiraKey(key)) {
        out.push({ key, type: firstDefined(linkTypeField(link.type, 'outward'), 'relates to') ?? 'relates to', direction: 'outward' });
      }
    }
    if (link.inwardIssue) {
      const key = firstDefined(link.inwardIssue.key, link.inwardIssue.issueKey);
      if (isJiraKey(key)) {
        out.push({ key, type: firstDefined(linkTypeField(link.type, 'inward'), 'relates to') ?? 'relates to', direction: 'inward' });
      }
    }
    // Flat shape: { key, type }
    if (!link.outwardIssue && !link.inwardIssue) {
      const key = firstDefined(link.key, link.issueKey);
      if (isJiraKey(key)) {
        const flatType = typeof link.type === 'string' ? link.type : link.type?.name;
        out.push({ key, type: firstDefined(flatType, 'relates to') ?? 'relates to', direction: 'outward' });
      }
    }
  }
  return out;
}

/**
 * Normalizes remote links, keeping only web links (Confluence and friends).
 */
function normalizeRemoteLinks(remoteLinks: JiraRemoteLink[] | undefined): DocLink[] {
  if (!Array.isArray(remoteLinks)) return [];
  const out: DocLink[] = [];
  for (const rl of remoteLinks) {
    const object: JiraRemoteLinkObject | JiraRemoteLink = rl?.object || rl || {};
    const url = firstDefined(object.url, rl.url);
    if (!url) continue;
    const title = firstDefined(object.title, rl.title, url) ?? url;
    const isConfluence =
      (firstDefined(rl.application?.type, rl.relationship, '') ?? '')
        .toString()
        .toLowerCase()
        .includes('confluence') || /confluence/i.test(url);
    out.push({ source: isConfluence ? 'confluence' : 'web', title, url });
  }
  return out;
}

export default AcliClient;
