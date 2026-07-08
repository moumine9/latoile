import { extractJiraKeys, isJiraKey } from './jiraKeys.js';

/**
 * Thin client around the Atlassian CLI (`acli`).
 *
 * The client asks `acli` to emit JSON for a single work item and normalizes it
 * into latoile's internal issue shape. The normalizer is deliberately defensive:
 * `acli` wraps the Jira REST issue representation, but exact field availability
 * varies by instance, so every accessor tolerates missing/renamed fields.
 */
export class AcliClient {
  /**
   * @param {object} deps
   * @param {(bin: string, args: string[]) => Promise<string>} deps.run
   * @param {string} [deps.bin]
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ run, bin = 'acli', log = () => {} }) {
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
   * @param {string} key
   * @returns {string[]}
   */
  viewArgs(key) {
    return ['jira', 'workitem', 'view', '--key', key, '--json'];
  }

  /**
   * Fetches and parses the raw JSON payload for an issue.
   * @param {string} key
   * @returns {Promise<object>}
   */
  async fetchRaw(key) {
    if (!isJiraKey(key)) {
      throw new Error(`Invalid Jira key: ${key}`);
    }
    const stdout = await this.run(this.bin, this.viewArgs(key));
    try {
      return JSON.parse(stdout);
    } catch (err) {
      throw new Error(`Failed to parse acli JSON for ${key}: ${err.message}`);
    }
  }

  /**
   * Fetches an issue and returns it normalized, or `null` if it cannot be
   * retrieved (e.g. permission denied / does not exist). Callers treat a null
   * as "known but unresolved" so the traversal keeps going.
   * @param {string} key
   * @returns {Promise<ReturnType<typeof normalizeIssue> | null>}
   */
  async fetchIssue(key) {
    try {
      const raw = await this.fetchRaw(key);
      return normalizeIssue(raw, key);
    } catch (err) {
      this.log(`skip ${key}: ${err.message}`);
      return null;
    }
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

/** Extracts a human-readable name from various Jira user shapes. */
function userName(user) {
  if (!user) return undefined;
  if (typeof user === 'string') return user;
  return firstDefined(user.displayName, user.name, user.emailAddress);
}

/** Extracts plain text from Jira's Atlassian Document Format or a string. */
export function textFromDescription(description) {
  if (!description) return '';
  if (typeof description === 'string') return description;
  // Atlassian Document Format: walk the tree collecting text nodes.
  const parts = [];
  const walk = (node) => {
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
 *
 * @param {object} raw
 * @param {string} [requestedKey] fallback key when the payload omits it
 */
export function normalizeIssue(raw, requestedKey) {
  const root = raw && typeof raw === 'object' ? raw : {};
  const fields = root.fields && typeof root.fields === 'object' ? root.fields : root;

  const key = firstDefined(root.key, root.issueKey, fields.key, requestedKey);

  const type = firstDefined(
    fields.issuetype?.name,
    fields.type?.name,
    fields.type,
    root.type
  );

  const title = firstDefined(fields.summary, fields.title, root.summary, root.title);
  const status = firstDefined(fields.status?.name, fields.status, root.status);
  const assignee = userName(firstDefined(fields.assignee, root.assignee));

  const parentKey = firstDefined(
    fields.parent?.key,
    fields.parent,
    fields.epic?.key,
    root.parent?.key,
    root.parentKey
  );

  const subtasks = normalizeSubtasks(firstDefined(fields.subtasks, root.subtasks));
  const links = normalizeIssueLinks(firstDefined(fields.issuelinks, root.issuelinks));

  const descriptionText = textFromDescription(
    firstDefined(fields.description, root.description)
  );
  const comments = normalizeComments(firstDefined(fields.comment?.comments, root.comments));
  const documentation = normalizeRemoteLinks(
    firstDefined(root.remoteLinks, fields.remoteLinks, root.documentation)
  );

  const mentionText = [descriptionText, ...comments].join('\n');
  const mentions = extractJiraKeys(mentionText).filter((k) => k !== key);

  return {
    key: typeof key === 'string' ? key : requestedKey,
    type: normalizeString(type),
    title: normalizeString(title),
    status: normalizeString(status),
    assignee: normalizeString(assignee),
    parentKey: typeof parentKey === 'string' ? parentKey : undefined,
    subtasks,
    links,
    mentions,
    documentation,
    description: descriptionText,
  };
}

function normalizeString(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return String(value);
}

function normalizeSubtasks(subtasks) {
  if (!Array.isArray(subtasks)) return [];
  return subtasks
    .map((st) => (typeof st === 'string' ? st : firstDefined(st.key, st.issueKey)))
    .filter((k) => isJiraKey(k));
}

function normalizeComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments
    .map((c) => (typeof c === 'string' ? c : textFromDescription(c.body)))
    .filter(Boolean);
}

/**
 * Normalizes Jira issue links into `{ key, type, direction }` records.
 * A link can point to an inward or outward issue depending on relationship.
 */
function normalizeIssueLinks(issuelinks) {
  if (!Array.isArray(issuelinks)) return [];
  const out = [];
  for (const link of issuelinks) {
    if (!link || typeof link !== 'object') continue;
    if (link.outwardIssue) {
      const key = firstDefined(link.outwardIssue.key, link.outwardIssue.issueKey);
      if (isJiraKey(key)) {
        out.push({ key, type: firstDefined(link.type?.outward, link.type?.name, 'relates to'), direction: 'outward' });
      }
    }
    if (link.inwardIssue) {
      const key = firstDefined(link.inwardIssue.key, link.inwardIssue.issueKey);
      if (isJiraKey(key)) {
        out.push({ key, type: firstDefined(link.type?.inward, link.type?.name, 'relates to'), direction: 'inward' });
      }
    }
    // Flat shape: { key, type }
    if (!link.outwardIssue && !link.inwardIssue) {
      const key = firstDefined(link.key, link.issueKey);
      if (isJiraKey(key)) {
        out.push({ key, type: firstDefined(link.type, 'relates to'), direction: 'outward' });
      }
    }
  }
  return out;
}

/**
 * Normalizes remote links, keeping only web links (Confluence and friends).
 */
function normalizeRemoteLinks(remoteLinks) {
  if (!Array.isArray(remoteLinks)) return [];
  return remoteLinks
    .map((rl) => {
      const object = rl?.object || rl || {};
      const url = firstDefined(object.url, rl.url);
      if (!url) return null;
      const title = firstDefined(object.title, rl.title, url);
      const isConfluence =
        firstDefined(rl.application?.type, rl.relationship, '')
          .toString()
          .toLowerCase()
          .includes('confluence') || /confluence/i.test(url);
      return { source: isConfluence ? 'confluence' : 'web', title, url };
    })
    .filter(Boolean);
}

export default AcliClient;
