/**
 * Shared internal domain types for latoile.
 *
 * These describe latoile's *normalized* shapes (produced by the collectors and
 * consumed by the model / API layers). Raw, instance-specific CLI payload shapes
 * live next to the collector that parses them.
 */

/** A typed Jira ↔ Jira issue link discovered on an issue. */
export type IssueLink = {
  key: string;
  type: string;
  direction: 'inward' | 'outward';
}

/** A documentation reference (Confluence / web link) attached to an issue. */
export type DocLink = {
  source: string;
  title: string;
  url: string;
}

/** An issue normalized from the Atlassian CLI payload. */
export type NormalizedIssue = {
  key: string | undefined;
  type: string | undefined;
  title: string | undefined;
  status: string | undefined;
  assignee: string | undefined;
  parentKey: string | undefined;
  subtasks: string[];
  links: IssueLink[];
  mentions: string[];
  documentation: DocLink[];
  description: string;
  /** Derived from Jira's dev-status field. undefined = unknown; false = confirmed none. */
  hasGitlabData?: boolean;
  /**
   * Set when this issue was served from the knowledge graph instead of a live
   * fetch. The sink skips such issues on ingest so `last_seen` keeps meaning
   * "last verified against Jira/GitLab".
   */
  provenance?: 'knowledge_graph';
}

/** A commit normalized from GitLab. */
export type Commit = {
  sha: string;
  shortSha: string;
  title: string;
  author: string | undefined;
  timestamp: string | undefined;
}

/** A merge request normalized from GitLab. */
export type MergeRequest = {
  iid: number;
  project: string | undefined;
  /** Numeric GitLab project id, when the API provided it. */
  projectId: number | undefined;
  title: string;
  state: string;
  sourceBranch: string | undefined;
  targetBranch: string | undefined;
  url: string | undefined;
  author: string | undefined;
  commits: Commit[];
  /** File paths touched by this MR. Only populated when file-diff ingestion is enabled. */
  changedFiles?: string[];
}

/** All GitLab context resolved for a single Jira key. */
export type GitlabContext = {
  mergeRequests: MergeRequest[];
}

/**
 * A node in the traversal graph. Starts as an unresolved placeholder and is
 * enriched in place once the issue is fetched.
 */
export type IssueNode = {
  key: string;
  resolved: boolean;
  depth: number;
  type?: string;
  title?: string;
  status?: string;
  assignee?: string;
  parentKey?: string;
  subtasks: string[];
  links: IssueLink[];
  mentions: string[];
  documentation: DocLink[];
  description?: string;
  gitlab: GitlabContext;
  /** Derived from Jira's dev-status field. undefined = unknown; false = confirmed none. */
  hasGitlabData?: boolean;
  /** Set when the issue came from the knowledge graph, not a live fetch. */
  provenance?: 'knowledge_graph';
  /**
   * Set when a live fetch for this key actively returned nothing (not
   * found/no permission), as opposed to a placeholder that was simply never
   * fetched (depth/node cap). Distinguishes "gone" from "unexplored".
   */
  missing?: boolean;
}

/** A recorded relationship between two Jira keys. */
export type Relation = {
  from: string;
  to: string;
  relation: string;
  linkType?: string;
  /** strong = structural Jira link; weak = text-mention only. */
  strength: 'strong' | 'weak';
}

/** Summary statistics for a traversal run. */
export type TraversalStats = {
  fetched: number;
  total: number;
  capped: boolean;
  maxDepthReached: boolean;
  maxDepth: number;
  maxNodes: number;
}

/** The full result of a breadth-first Jira traversal. */
export type TraversalResult = {
  entry: string;
  issues: Map<string, IssueNode>;
  relations: Relation[];
  stats: TraversalStats;
}

/* -------------------------------------------------------------------------- */
/* Renderable graph                                                            */
/* -------------------------------------------------------------------------- */

export type JiraGraphNode = {
  id: string;
  type: 'jira';
  key: string;
  resolved: boolean;
  isEntry: boolean;
  depth: number;
  title?: string;
  issueType?: string;
  status?: string;
  assignee?: string;
  parentKey?: string;
  documentation: DocLink[];
  url?: string;
}

/** Commit reference carried on the MR graph node (commits are not nodes). */
export type GraphCommitRef = {
  sha: string;
  shortSha: string;
  title: string;
  author: string | undefined;
  timestamp: string | undefined;
  url?: string;
}

export type MergeRequestGraphNode = {
  id: string;
  type: 'merge_request';
  iid: number;
  project: string | undefined;
  title: string;
  state: string;
  sourceBranch: string | undefined;
  targetBranch: string | undefined;
  url: string | undefined;
  author: string | undefined;
  /** Branch and commits are folded into the MR node rather than rendered as nodes. */
  commitCount: number;
  commits: GraphCommitRef[];
}

export type DocGraphNode = {
  id: string;
  type: 'doc';
  source: string;
  title: string;
  url: string;
}

export type GraphNode =
  | JiraGraphNode
  | MergeRequestGraphNode
  | DocGraphNode;

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  linkType?: string;
  /** strong = structural; weak = text-mention only. */
  strength: 'strong' | 'weak';
}

export type GraphResult = {
  entry: string;
  stats: TraversalStats & { nodes: number; edges: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/* -------------------------------------------------------------------------- */
/* Normalized LLM context payload                                              */
/* -------------------------------------------------------------------------- */

export type ContextWorkItem = {
  id: string | undefined;
  type: string | undefined;
  title: string | undefined;
  status: string | undefined;
  assignee: string | undefined;
  parent_id: string | undefined;
}

export type ContextBranch = {
  name: string;
  last_commit_sha: string | undefined;
}

export type ContextCommit = {
  sha: string;
  title: string;
  author: string | undefined;
  timestamp: string | undefined;
}

export type ContextMergeRequestDetail = {
  id: number;
  title: string;
  state: string;
  source_branch: string | undefined;
  target_branch: string | undefined;
  url: string | undefined;
}

export type ContextGitlab = {
  merge_request: ContextMergeRequestDetail;
  branch: ContextBranch | undefined;
  commits: ContextCommit[];
}

export type ContextMergeRequestSummary = {
  id: number;
  project: string | undefined;
  title: string;
  state: string;
  url: string | undefined;
}

export type ContextDoc = {
  source: string;
  title: string;
  url: string;
}

export type ContextItem = {
  work_item: ContextWorkItem;
  gitlab: ContextGitlab | undefined;
  merge_requests: ContextMergeRequestSummary[];
  /**
   * Distinct GitLab project paths this work item's MRs live in. Work items
   * routinely span several repos (microservices + microfrontends); a fix
   * attempt should consider every repo the original fix touched.
   */
  repositories: string[];
  documentation: ContextDoc[];
}

export type TraceabilityLink = {
  jira_key: string | undefined;
  merge_request_id: number;
}

export type ContextResult = {
  entry: string;
  items: ContextItem[];
  /** Union of every item's repositories — the repos involved in this context. */
  repositories: string[];
  traceability: { links: TraceabilityLink[] };
}

/** A function that runs a CLI binary with an argument vector. */
export type RunFn = (bin: string, args: string[]) => Promise<string>;

/** A logging sink used across the collector. */
export type LogFn = (msg: string) => void;
