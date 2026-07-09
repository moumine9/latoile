import { isJiraKey } from './jiraKeys.js';
import type {
  GitlabContext,
  IssueNode,
  LogFn,
  NormalizedIssue,
  Relation,
  TraversalResult,
} from '../types.js';

/** Minimal Jira issue source contract required by the traversal. */
export interface IssueSource {
  fetchIssue(key: string): Promise<NormalizedIssue | null>;
}

/** Minimal GitLab source contract required by the traversal. */
export interface GitlabSource {
  fetchForKey(key: string): Promise<GitlabContext>;
}

export interface TraverseDeps {
  acli: IssueSource;
  glab: GitlabSource;
}

export interface TraverseOptions {
  maxDepth?: number;
  maxNodes?: number;
  log?: LogFn;
}

type AddRelation = (from: string, to: string, relation: string, linkType?: string) => void;

interface Neighbor {
  key: string;
  relation: string;
  linkType?: string;
}

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
 */
export async function traverse(
  entryKey: string,
  { acli, glab }: TraverseDeps,
  options: TraverseOptions = {}
): Promise<TraversalResult> {
  const { maxDepth = 1, maxNodes = 50, log = () => {} } = options;

  if (!isJiraKey(entryKey)) {
    throw new Error(`Invalid entry Jira key: ${entryKey}`);
  }

  const issues = new Map<string, IssueNode>();
  const relations: Relation[] = [];
  const relationSeen = new Set<string>();
  const visited = new Set<string>();

  let capped = false;
  let maxDepthReached = false;

  const addRelation: AddRelation = (from, to, relation, linkType) => {
    if (!from || !to || from === to) return;
    const id = `${from}|${to}|${relation}|${linkType || ''}`;
    if (relationSeen.has(id)) return;
    relationSeen.add(id);
    const strength: 'strong' | 'weak' = relation === 'mention' ? 'weak' : 'strong';
    relations.push(linkType ? { from, to, relation, linkType, strength } : { from, to, relation, strength });
  };

  // Ensure a placeholder node exists for any key referenced by an edge, so the
  // graph can render keys that were discovered but not fetched (depth/cap).
  const ensureNode = (key: string, depth: number): IssueNode => {
    let node = issues.get(key);
    if (!node) {
      node = {
        key,
        resolved: false,
        depth,
        subtasks: [],
        links: [],
        mentions: [],
        documentation: [],
        gitlab: { mergeRequests: [] },
      };
      issues.set(key, node);
    }
    return node;
  };

  const queue: Array<{ key: string; depth: number }> = [{ key: entryKey, depth: 0 }];
  visited.add(entryKey);
  ensureNode(entryKey, 0);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const { key, depth } = current;

    if (issues.size > maxNodes && issues.get(key)?.resolved) {
      continue;
    }

    log(`Fetching Jira issue ${key}...`);
    const issue = await acli.fetchIssue(key);
    const node = ensureNode(key, depth);
    node.depth = Math.min(node.depth, depth);

    if (!issue) {
      // Unresolved (permission/not found): keep placeholder, keep traversing.
      node.resolved = false;
      continue;
    }

    Object.assign(node, issue, { resolved: true, depth: node.depth });

    // Skip GitLab enrichment when Jira's dev-status field confirms there are
    // no associated branches, commits, or MRs for this issue.
    if (issue.hasGitlabData !== false) {
      try {
        log(`Fetching GitLab data for ${key}...`);
        node.gitlab = await glab.fetchForKey(key);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        
        // Extract a shorter error message for the UI
        let shortMessage = (message.split('—')[0] || message).trim();
        const colonIdx = shortMessage.lastIndexOf(':');
        if (colonIdx > 0) {
          shortMessage = shortMessage.substring(colonIdx + 1).trim();
        }
        
        log(`GitLab data unavailable for ${key} (${shortMessage})`);
        node.gitlab = { mergeRequests: [] };
      }
    }

    log(`Processing relations for ${key}...`);
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

/** Flattens an issue's relationships into a list of typed neighbor references. */
function collectNeighbors(issue: NormalizedIssue): Neighbor[] {
  const out: Neighbor[] = [];
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
 *
 * Sibling edges are only emitted when the shared parent is NOT a node in the
 * graph: when it is, the parent/subtask edges already convey the relationship,
 * and a full sibling clique grows quadratically with family size (a 20-child
 * epic would add 380 edges). Each pair is emitted once, in sorted key order.
 */
function deriveSiblings(issues: Map<string, IssueNode>, addRelation: AddRelation): void {
  const childrenByParent = new Map<string, Set<string>>();
  const register = (parent: string | undefined, child: string): void => {
    if (!parent || !child || parent === child) return;
    let children = childrenByParent.get(parent);
    if (!children) {
      children = new Set<string>();
      childrenByParent.set(parent, children);
    }
    children.add(child);
  };

  for (const node of issues.values()) {
    if (node.parentKey) register(node.parentKey, node.key);
    for (const st of node.subtasks || []) register(node.key, st);
  }

  for (const [parent, children] of childrenByParent) {
    if (issues.has(parent)) continue;
    const list = [...children].sort();
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a === undefined || b === undefined) continue;
        addRelation(a, b, 'sibling');
      }
    }
  }
}

export default traverse;
