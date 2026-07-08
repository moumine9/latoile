/**
 * Builds a renderable graph (`{ nodes, edges }`) and the normalized LLM context
 * payload from a traversal result.
 *
 * Node types : jira | merge_request | commit | branch | doc
 * Edge types : parent | subtask | sibling | link | mention  (Jira ↔ Jira)
 *              has_mr | has_branch | has_commit             (Jira → GitLab)
 *              documented_by                                (Jira → doc)
 */
import type {
  Commit,
  ContextItem,
  ContextResult,
  DocLink,
  GraphEdge,
  GraphNode,
  GraphResult,
  MergeRequest,
  TraceabilityLink,
  TraversalResult,
} from '../types.js';

function mrNodeId(mr: MergeRequest): string {
  return `mr:${mr.project || 'default'}!${mr.iid}`;
}
function branchNodeId(mr: MergeRequest): string {
  return `branch:${mr.project || 'default'}@${mr.sourceBranch}`;
}
function commitNodeId(commit: Commit): string {
  return `commit:${commit.sha}`;
}
function docNodeId(doc: DocLink): string {
  return `doc:${doc.url}`;
}

export function buildGraph(traversal: TraversalResult): GraphResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIndex = new Map<string, GraphNode>();
  const edgeSeen = new Set<string>();

  const addNode = (node: GraphNode): GraphNode => {
    const existing = nodeIndex.get(node.id);
    if (existing) return existing;
    nodeIndex.set(node.id, node);
    nodes.push(node);
    return node;
  };

  const addEdge = (source: string, target: string, type: string, linkType?: string): void => {
    if (!source || !target) return;
    const id = `${source}->${target}:${type}`;
    if (edgeSeen.has(id)) return;
    edgeSeen.add(id);
    edges.push(linkType ? { id, source, target, type, linkType } : { id, source, target, type });
  };

  const issues = traversal.issues;

  // Jira nodes -------------------------------------------------------------
  for (const issue of issues.values()) {
    addNode({
      id: issue.key,
      type: 'jira',
      key: issue.key,
      resolved: Boolean(issue.resolved),
      isEntry: issue.key === traversal.entry,
      depth: issue.depth,
      title: issue.title,
      issueType: issue.type,
      status: issue.status,
      assignee: issue.assignee,
      parentKey: issue.parentKey,
      documentation: issue.documentation || [],
    });
  }

  // Jira ↔ Jira edges ------------------------------------------------------
  for (const rel of traversal.relations || []) {
    addEdge(rel.from, rel.to, rel.relation, rel.linkType);
  }

  // GitLab + documentation nodes/edges ------------------------------------
  for (const issue of issues.values()) {
    const mrs = issue.gitlab?.mergeRequests || [];
    for (const mr of mrs) {
      const mrId = mrNodeId(mr);
      addNode({
        id: mrId,
        type: 'merge_request',
        iid: mr.iid,
        project: mr.project,
        title: mr.title,
        state: mr.state,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        url: mr.url,
        author: mr.author,
      });
      addEdge(issue.key, mrId, 'has_mr');

      if (mr.sourceBranch) {
        const bId = branchNodeId(mr);
        addNode({
          id: bId,
          type: 'branch',
          name: mr.sourceBranch,
          project: mr.project,
        });
        addEdge(mrId, bId, 'has_branch');
      }

      for (const commit of mr.commits || []) {
        const cId = commitNodeId(commit);
        addNode({
          id: cId,
          type: 'commit',
          sha: commit.sha,
          shortSha: commit.shortSha,
          title: commit.title,
          author: commit.author,
          timestamp: commit.timestamp,
        });
        addEdge(mrId, cId, 'has_commit');
      }
    }

    for (const doc of issue.documentation || []) {
      const dId = docNodeId(doc);
      addNode({
        id: dId,
        type: 'doc',
        source: doc.source,
        title: doc.title,
        url: doc.url,
      });
      addEdge(issue.key, dId, 'documented_by');
    }
  }

  return {
    entry: traversal.entry,
    stats: { ...traversal.stats, nodes: nodes.length, edges: edges.length },
    nodes,
    edges,
  };
}

/**
 * Produces the normalized, LLM-friendly context payload (an array of unified
 * work-item objects matching the model documented in the README).
 */
export function buildContext(traversal: TraversalResult): ContextResult {
  const issues = traversal.issues;

  const items: ContextItem[] = [];
  for (const issue of issues.values()) {
    if (!issue.resolved) continue;
    const mrs = issue.gitlab?.mergeRequests || [];
    const primary = mrs[0];
    items.push({
      work_item: {
        id: issue.key,
        type: issue.type,
        title: issue.title,
        status: issue.status,
        assignee: issue.assignee,
        parent_id: issue.parentKey,
      },
      gitlab: primary
        ? {
            merge_request: {
              id: primary.iid,
              title: primary.title,
              state: primary.state,
              source_branch: primary.sourceBranch,
              target_branch: primary.targetBranch,
              url: primary.url,
            },
            branch: primary.sourceBranch
              ? {
                  name: primary.sourceBranch,
                  last_commit_sha: primary.commits?.[0]?.sha,
                }
              : undefined,
            commits: (primary.commits || []).map((c) => ({
              sha: c.sha,
              title: c.title,
              author: c.author,
              timestamp: c.timestamp,
            })),
          }
        : undefined,
      merge_requests: mrs.map((mr) => ({
        id: mr.iid,
        project: mr.project,
        title: mr.title,
        state: mr.state,
        url: mr.url,
      })),
      documentation: (issue.documentation || []).map((d) => ({
        source: d.source,
        title: d.title,
        url: d.url,
      })),
    });
  }

  const links: TraceabilityLink[] = [];
  for (const item of items) {
    const key = item.work_item.id;
    for (const mr of item.merge_requests) {
      links.push({ jira_key: key, merge_request_id: mr.id });
    }
  }

  return { entry: traversal.entry, items, traceability: { links } };
}

export default buildGraph;
