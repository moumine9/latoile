import { isJiraKey } from './jiraKeys.js';

/**
 * Breadth-first traversal of the Jira relationship graph starting from a single
 * entry-point key. Every discovered relationship is recorded with its semantic
 * type so downstream edges are meaningful.
 *
 * The traversal:
 *   - fetches each issue exactly once (visited-set keyed by Jira key),
 *   - follows parent, subtasks, issue links and description/comment mentions,
 *   - derives sibling relationships from shared parents,
 *   - respects `maxDepth` and `maxNodes`,
 *   - enriches every resolved issue with its GitLab context.
 *
 * @param {string} entryKey
 * @param {object} deps
 * @param {{ fetchIssue: (key: string) => Promise<object|null> }} deps.acli
 * @param {{ fetchForKey: (key: string) => Promise<{ mergeRequests: object[] }> }} deps.glab
 * @param {object} [options]
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxNodes]
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<object>} traversal result
 */
export async function traverse(entryKey, { acli, glab }, options = {}) {
  const { maxDepth = 2, maxNodes = 100, log = () => {} } = options;

  if (!isJiraKey(entryKey)) {
    throw new Error(`Invalid entry Jira key: ${entryKey}`);
  }

  /** @type {Map<string, object>} key -> issue node */
  const issues = new Map();
  /** @type {Array<{from:string,to:string,relation:string,linkType?:string}>} */
  const relations = [];
  const relationSeen = new Set();
  const visited = new Set();

  let capped = false;
  let maxDepthReached = false;

  const addRelation = (from, to, relation, linkType) => {
    if (!from || !to || from === to) return;
    const id = `${from}|${to}|${relation}|${linkType || ''}`;
    if (relationSeen.has(id)) return;
    relationSeen.add(id);
    relations.push(linkType ? { from, to, relation, linkType } : { from, to, relation });
  };

  // Ensure a placeholder node exists for any key referenced by an edge, so the
  // graph can render keys that were discovered but not fetched (depth/cap).
  const ensureNode = (key, depth) => {
    if (!issues.has(key)) {
      issues.set(key, {
        key,
        resolved: false,
        depth,
        subtasks: [],
        links: [],
        mentions: [],
        documentation: [],
        gitlab: { mergeRequests: [] },
      });
    }
    return issues.get(key);
  };

  const queue = [{ key: entryKey, depth: 0 }];
  visited.add(entryKey);
  ensureNode(entryKey, 0);

  while (queue.length > 0) {
    const { key, depth } = queue.shift();

    if (issues.size > maxNodes && issues.get(key)?.resolved) {
      continue;
    }

    const issue = await acli.fetchIssue(key);
    const node = ensureNode(key, depth);
    node.depth = Math.min(node.depth, depth);

    if (!issue) {
      // Unresolved (permission/not found): keep placeholder, keep traversing.
      node.resolved = false;
      continue;
    }

    Object.assign(node, issue, { resolved: true, depth: node.depth });

    // Enrich with GitLab context (never throws).
    try {
      node.gitlab = await glab.fetchForKey(key);
    } catch (err) {
      log(`gitlab enrichment failed for ${key}: ${err.message}`);
      node.gitlab = { mergeRequests: [] };
    }

    const neighbors = collectNeighbors(issue);

    for (const { key: nKey, relation, linkType } of neighbors) {
      if (!isJiraKey(nKey) || nKey === key) continue;
      addRelation(key, nKey, relation, linkType);
      ensureNode(nKey, depth + 1);

      if (visited.has(nKey)) continue;

      if (depth + 1 > maxDepth) {
        maxDepthReached = true;
        continue;
      }
      if (visited.size >= maxNodes) {
        capped = true;
        continue;
      }
      visited.add(nKey);
      queue.push({ key: nKey, depth: depth + 1 });
    }
  }

  deriveSiblings(issues, addRelation);

  return {
    entry: entryKey,
    issues,
    relations,
    stats: {
      fetched: [...issues.values()].filter((n) => n.resolved).length,
      total: issues.size,
      capped,
      maxDepthReached,
      maxDepth,
      maxNodes,
    },
  };
}

/**
 * Flattens an issue's relationships into a list of typed neighbor references.
 * @param {object} issue
 */
function collectNeighbors(issue) {
  const out = [];
  if (issue.parentKey) out.push({ key: issue.parentKey, relation: 'parent' });
  for (const st of issue.subtasks || []) out.push({ key: st, relation: 'subtask' });
  for (const link of issue.links || []) {
    out.push({ key: link.key, relation: 'link', linkType: link.type });
  }
  for (const m of issue.mentions || []) out.push({ key: m, relation: 'mention' });
  return out;
}

/**
 * Derives sibling relationships: two issues are siblings when they share the
 * same parent. Parents are known both from `parentKey` and `subtasks` arrays.
 * @param {Map<string, object>} issues
 * @param {(from:string,to:string,relation:string)=>void} addRelation
 */
function deriveSiblings(issues, addRelation) {
  /** @type {Map<string, Set<string>>} parent -> children */
  const childrenByParent = new Map();
  const register = (parent, child) => {
    if (!parent || !child || parent === child) return;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, new Set());
    childrenByParent.get(parent).add(child);
  };

  for (const node of issues.values()) {
    if (node.parentKey) register(node.parentKey, node.key);
    for (const st of node.subtasks || []) register(node.key, st);
  }

  for (const children of childrenByParent.values()) {
    const list = [...children];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        addRelation(list[i], list[j], 'sibling');
        addRelation(list[j], list[i], 'sibling');
      }
    }
  }
}

export default traverse;
