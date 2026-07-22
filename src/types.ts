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

/**
 * A comment on a Jira issue, normalized to plain text. Comments are not graph
 * nodes — they ride on the issue (like commits ride on the MR) and feed the
 * LLM context payload and mention extraction.
 */
export type IssueComment = {
  author: string;
  created: string;
  body: string;
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
  comments: IssueComment[];
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
  comments?: IssueComment[];
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

export type ContextComment = {
  author: string;
  created: string;
  body: string;
}

/** A single code definition surfaced from a local GitLab Orbit graph. */
export type ContextCodeDefinition = {
  name: string;
  /** Orbit's definition_type, e.g. Class | Function | Interface | Module. */
  kind: string;
  /** Repo-relative path (matches the MR's changed-file paths). */
  file: string;
  start_line: number | undefined;
}

/**
 * The "code neighborhood" for one repository an issue touched: definitions that
 * live in the files the issue's MRs changed, read from a local Orbit graph.
 *
 * IMPORTANT — this is a *navigation aid, not a record of the change*. Orbit
 * indexes whatever branch was checked out locally (`branch`/`commit_sha`), which
 * is almost never the MR's branch, so these are the definitions **as they stand
 * on the indexed branch**. Three states are distinguished:
 *   - `indexed: false`            → repo isn't in the local Orbit graph at all
 *   - `indexed: true`, `files_matched === 0` → changed files aren't present on the
 *      indexed branch (branch drift / renamed / deleted) — treat with suspicion
 *   - `indexed: true`, definitions present → best-effort match on the indexed branch
 */
export type ContextCodeNeighborhood = {
  /** GitLab project path this neighborhood is for (mirrors `repositories`). */
  repository: string;
  /** Whether the repo was found in the local Orbit graph. */
  indexed: boolean;
  /** Locally indexed branch — NOT the MR branch. Present when `indexed`. */
  branch: string | undefined;
  commit_sha: string | undefined;
  /** Changed files considered for this repo. */
  files_changed: number;
  /** Of those, how many had at least one definition on the indexed branch. */
  files_matched: number;
  definitions: ContextCodeDefinition[];
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
  /**
   * Issue comments (most recent last, capped). Comments often carry key
   * behavior decisions that never make it into the description.
   */
  comments: ContextComment[];
  /**
   * Optional code neighborhood per touched repo, from a local Orbit graph.
   * Present only when `LATOILE_ORBIT=1` (and MR changed files are available).
   * Read the caveats on `ContextCodeNeighborhood` — indexed-branch, not MR-branch.
   */
  code?: ContextCodeNeighborhood[];
}

export type TraceabilityLink = {
  jira_key: string | undefined;
  merge_request_id: number;
}

/**
 * Traversal completeness, so a consumer can tell a genuine empty neighborhood
 * from one that was truncated by the depth/node budget. `node_cap_hit` and
 * `depth_limit_hit` are kept separate because they imply different remedies
 * (raise `maxNodes` vs. raise `maxDepth`).
 */
export type ContextTraversalInfo = {
  /** Issues actually fetched and resolved. */
  nodes_fetched: number;
  /** Nodes discovered, including unresolved placeholders beyond the budget. */
  total_nodes: number;
  /** Deepest resolved issue's distance from the entry key. */
  depth_reached: number;
  max_depth: number;
  max_nodes: number;
  /** The node cap stopped further fetching — raise `maxNodes` for more. */
  node_cap_hit: boolean;
  /** Neighbors past `maxDepth` were left unresolved — raise `maxDepth` for more. */
  depth_limit_hit: boolean;
}

export type ContextResult = {
  entry: string;
  items: ContextItem[];
  /** Union of every item's repositories — the repos involved in this context. */
  repositories: string[];
  traceability: { links: TraceabilityLink[] };
  /** Present on live/partial and knowledge-graph-served payloads. */
  traversal?: ContextTraversalInfo;
}

/** A function that runs a CLI binary with an argument vector. */
export type RunFn = (bin: string, args: string[]) => Promise<string>;

/** A logging sink used across the collector. */
export type LogFn = (msg: string) => void;
