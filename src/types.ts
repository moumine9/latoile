/**
 * Shared internal domain types for latoile.
 *
 * These describe latoile's *normalized* shapes (produced by the collectors and
 * consumed by the model / API layers). Raw, instance-specific CLI payload shapes
 * live next to the collector that parses them.
 */

/** A typed Jira ↔ Jira issue link discovered on an issue. */
export interface IssueLink {
  key: string;
  type: string;
  direction: 'inward' | 'outward';
}

/** A documentation reference (Confluence / web link) attached to an issue. */
export interface DocLink {
  source: string;
  title: string;
  url: string;
}

/** An issue normalized from the Atlassian CLI payload. */
export interface NormalizedIssue {
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
}

/** A commit normalized from GitLab. */
export interface Commit {
  sha: string;
  shortSha: string;
  title: string;
  author: string | undefined;
  timestamp: string | undefined;
}

/** A merge request normalized from GitLab. */
export interface MergeRequest {
  iid: number;
  project: string | undefined;
  title: string;
  state: string;
  sourceBranch: string | undefined;
  targetBranch: string | undefined;
  url: string | undefined;
  author: string | undefined;
  commits: Commit[];
}

/** All GitLab context resolved for a single Jira key. */
export interface GitlabContext {
  mergeRequests: MergeRequest[];
}

/**
 * A node in the traversal graph. Starts as an unresolved placeholder and is
 * enriched in place once the issue is fetched.
 */
export interface IssueNode {
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
}

/** A recorded relationship between two Jira keys. */
export interface Relation {
  from: string;
  to: string;
  relation: string;
  linkType?: string;
}

/** Summary statistics for a traversal run. */
export interface TraversalStats {
  fetched: number;
  total: number;
  capped: boolean;
  maxDepthReached: boolean;
  maxDepth: number;
  maxNodes: number;
}

/** The full result of a breadth-first Jira traversal. */
export interface TraversalResult {
  entry: string;
  issues: Map<string, IssueNode>;
  relations: Relation[];
  stats: TraversalStats;
}

/* -------------------------------------------------------------------------- */
/* Renderable graph                                                            */
/* -------------------------------------------------------------------------- */

export interface JiraGraphNode {
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
}

export interface MergeRequestGraphNode {
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
}

export interface BranchGraphNode {
  id: string;
  type: 'branch';
  name: string | undefined;
  project: string | undefined;
}

export interface CommitGraphNode {
  id: string;
  type: 'commit';
  sha: string;
  shortSha: string;
  title: string;
  author: string | undefined;
  timestamp: string | undefined;
}

export interface DocGraphNode {
  id: string;
  type: 'doc';
  source: string;
  title: string;
  url: string;
}

export type GraphNode =
  | JiraGraphNode
  | MergeRequestGraphNode
  | BranchGraphNode
  | CommitGraphNode
  | DocGraphNode;

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  linkType?: string;
}

export interface GraphResult {
  entry: string;
  stats: TraversalStats & { nodes: number; edges: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/* -------------------------------------------------------------------------- */
/* Normalized LLM context payload                                              */
/* -------------------------------------------------------------------------- */

export interface ContextWorkItem {
  id: string | undefined;
  type: string | undefined;
  title: string | undefined;
  status: string | undefined;
  assignee: string | undefined;
  parent_id: string | undefined;
}

export interface ContextBranch {
  name: string;
  last_commit_sha: string | undefined;
}

export interface ContextCommit {
  sha: string;
  title: string;
  author: string | undefined;
  timestamp: string | undefined;
}

export interface ContextMergeRequestDetail {
  id: number;
  title: string;
  state: string;
  source_branch: string | undefined;
  target_branch: string | undefined;
  url: string | undefined;
}

export interface ContextGitlab {
  merge_request: ContextMergeRequestDetail;
  branch: ContextBranch | undefined;
  commits: ContextCommit[];
}

export interface ContextMergeRequestSummary {
  id: number;
  project: string | undefined;
  title: string;
  state: string;
  url: string | undefined;
}

export interface ContextDoc {
  source: string;
  title: string;
  url: string;
}

export interface ContextItem {
  work_item: ContextWorkItem;
  gitlab: ContextGitlab | undefined;
  merge_requests: ContextMergeRequestSummary[];
  documentation: ContextDoc[];
}

export interface TraceabilityLink {
  jira_key: string | undefined;
  merge_request_id: number;
}

export interface ContextResult {
  entry: string;
  items: ContextItem[];
  traceability: { links: TraceabilityLink[] };
}

/** A function that runs a CLI binary with an argument vector. */
export type RunFn = (bin: string, args: string[]) => Promise<string>;

/** A logging sink used across the collector. */
export type LogFn = (msg: string) => void;
