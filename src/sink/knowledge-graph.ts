/**
 * Read side of the Neo4j knowledge graph (PLAN-NEO4J.md phase 2).
 *
 * Canned, parameterized Cypher only — no raw query passthrough. Like the
 * sink, the class depends on an injectable query function so unit tests need
 * no database; `createKnowledgeGraph` wires the real driver lazily.
 */
import { normalizePersonToken } from './person-identity.js';
import type { LogFn } from '../types.js';

/** Runs one read query and returns the result rows as plain objects. */
export type CypherQueryFn = (
  query: string,
  params: Record<string, unknown>
) => Promise<Array<Record<string, unknown>>>;

export interface KnowledgeGraphDeps {
  query: CypherQueryFn;
  close?: () => Promise<void>;
  log?: LogFn;
}

export interface PathNode {
  label: string;
  id: string;
  title: string | null;
}

export interface ConnectionResult {
  found: boolean;
  /** Alternating description: nodes[0] -rels[0]-> nodes[1] ... */
  nodes: PathNode[];
  relationships: string[];
}

/** Issue fields as stored on a `:Issue` node. */
export interface StoredIssue {
  key: string;
  title?: string;
  type?: string;
  status?: string;
  assignee?: string;
  resolved?: boolean;
  first_seen?: string;
  last_seen?: string;
}

/** One edge from an issue to any neighboring node, as seen from the issue. */
export interface StoredNeighbor {
  relation: string;
  direction: 'out' | 'in';
  label: string;
  id: string;
  title: string | null;
}

export interface KnownContextResult {
  found: boolean;
  issue?: StoredIssue;
  neighbors?: StoredNeighbor[];
  /** Seconds since this issue was last refreshed from live sources. */
  ageSeconds?: number;
}

/** Mirrors the live pipeline's ContextItem, rebuilt from stored data. */
export interface StoredContextItem {
  work_item: {
    id: string;
    type?: string;
    title?: string;
    status?: string;
    assignee?: string;
    parent_id?: string;
  };
  merge_requests: Array<{
    id: number;
    project?: string;
    title?: string;
    state?: string;
    url?: string;
  }>;
  commits: StoredCommit[];
}

export interface StoredCommit {
  sha: string;
  title?: string;
  timestamp?: string;
}

export interface StoredTraceabilityLink {
  jira_key: string;
  merge_request_id: number;
}

export interface StoredContextResult {
  found: boolean;
  entry?: string;
  items?: StoredContextItem[];
  traceability?: { links: StoredTraceabilityLink[] };
  /** Age of the STALEST resolved issue — safe to compare against a freshness budget. */
  ageSeconds?: number;
}

export interface PersonActivityMatch {
  person: { key: string; name?: string; jiraName?: string; gitlabUsername?: string };
  issues: Array<{ key: string; title?: string; status?: string }>;
  mergeRequests: Array<{ project?: string; iid: number; title?: string; state?: string }>;
  commitCount: number;
}

export interface PersonActivityResult {
  matches: PersonActivityMatch[];
  sinceDays: number;
}

export interface GraphStatsResult {
  nodes: Array<{ label: string; count: number; oldest_first_seen: string | null; newest_last_seen: string | null }>;
  relationships: Array<{ type: string; count: number }>;
}

/** Whole seconds elapsed since an ISO datetime; undefined when unparsable. */
function secondsSince(isoDate: string | undefined): number | undefined {
  if (!isoDate) return undefined;
  const ms = Date.parse(isoDate);
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

export class KnowledgeGraph {
  private deps: KnowledgeGraphDeps;

  constructor(deps: KnowledgeGraphDeps) {
    this.deps = deps;
  }

  /** Shortest path between two issues over any relationship types. */
  async findConnection(keyA: string, keyB: string, maxHops = 8): Promise<ConnectionResult> {
    const rows = await this.deps.query(
      `MATCH (a:Issue {key: $a}), (b:Issue {key: $b})
       MATCH p = shortestPath((a)-[*..${Math.min(Math.max(maxHops, 1), 15)}]-(b))
       RETURN [n IN nodes(p) | {
                label: labels(n)[0],
                id: coalesce(n.key, n.sha, n.name, n.url, toString(n.iid)),
                title: n.title
              }] AS nodes,
              [r IN relationships(p) | type(r)] AS relationships`,
      { a: keyA, b: keyB }
    );
    const row = rows[0];
    if (!row) return { found: false, nodes: [], relationships: [] };
    return {
      found: true,
      nodes: row.nodes as PathNode[],
      relationships: row.relationships as string[],
    };
  }

  /** Everything the graph already knows about one issue, with freshness. */
  async knownContext(key: string): Promise<KnownContextResult> {
    const rows = await this.deps.query(
      `MATCH (i:Issue {key: $key})
       OPTIONAL MATCH (i)-[r]-(nb)
       WITH i, r, nb
       RETURN i {.key, .title, .type, .status, .assignee, .resolved,
                 first_seen: toString(i.first_seen), last_seen: toString(i.last_seen)} AS issue,
              collect(CASE WHEN nb IS NULL THEN NULL ELSE {
                relation: type(r),
                direction: CASE WHEN startNode(r) = i THEN 'out' ELSE 'in' END,
                label: labels(nb)[0],
                id: coalesce(nb.key, nb.sha, nb.name, nb.url, toString(nb.iid)),
                title: nb.title
              } END) AS neighbors`,
      { key }
    );
    const row = rows[0];
    if (!row) return { found: false };
    const issue = row.issue as StoredIssue;
    return {
      found: true,
      issue,
      neighbors: (row.neighbors as Array<StoredNeighbor | null>).filter(
        (n): n is StoredNeighbor => n !== null
      ),
      ageSeconds: secondsSince(issue.last_seen),
    };
  }

  /**
   * Issues assigned to and MRs/commits authored by a person. Matches any
   * identity: canonical key, display name, Jira name, or GitLab username
   * (case/accent-insensitive substring).
   */
  async personActivity(name: string, sinceDays = 90): Promise<PersonActivityResult> {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = await this.deps.query(
      `MATCH (p:Person)
       WHERE p.key CONTAINS $normalized
          OR toLower(coalesce(p.name, '')) CONTAINS toLower($name)
          OR toLower(coalesce(p.jiraName, '')) CONTAINS toLower($name)
          OR toLower(coalesce(p.gitlabUsername, '')) CONTAINS toLower($name)
       OPTIONAL MATCH (i:Issue)-[:ASSIGNED_TO]->(p) WHERE i.last_seen >= datetime($since)
       WITH p, collect(DISTINCT i {.key, .title, .status}) AS issues
       OPTIONAL MATCH (mr:MergeRequest)-[:AUTHORED_BY]->(p) WHERE mr.last_seen >= datetime($since)
       WITH p, issues, collect(DISTINCT mr {.project, .iid, .title, .state}) AS mergeRequests
       OPTIONAL MATCH (c:Commit)-[:AUTHORED_BY]->(p) WHERE c.last_seen >= datetime($since)
       RETURN p {.key, .name, .jiraName, .gitlabUsername} AS person,
              issues, mergeRequests, count(DISTINCT c) AS commitCount`,
      { name, normalized: normalizePersonToken(name), since }
    );
    return { matches: rows as unknown as PersonActivityMatch[], sinceDays };
  }

  /**
   * Reassembles a full context payload (same shape as the live pipeline's
   * `ContextResult`) from stored data: the issue neighborhood up to `maxDepth`
   * hops over Jira relationships, each issue's MRs and commits, and
   * traceability links. `ageSeconds` is the age of the *stalest* resolved
   * issue in the neighborhood, so callers comparing against a freshness
   * budget never serve partially-expired data.
   */
  async storedContext(entryKey: string, maxDepth = 1): Promise<StoredContextResult> {
    const depth = Math.min(Math.max(Math.trunc(maxDepth), 1), 5);
    const rows = await this.deps.query(
      `MATCH (entry:Issue {key: $key})
       OPTIONAL MATCH (entry)-[:PARENT_OF|HAS_SUBTASK|LINKS_TO|MENTIONS*..${depth}]-(other:Issue)
       WITH entry, collect(DISTINCT other) AS others
       UNWIND [entry] + others AS i
       WITH DISTINCT i
       OPTIONAL MATCH (parent:Issue)-[:PARENT_OF]->(i)
       OPTIONAL MATCH (i)-[:HAS_MR]->(mr:MergeRequest)
       OPTIONAL MATCH (mr)-[:HAS_COMMIT]->(c:Commit)
       WITH i, parent, mr, collect(c {.sha, .title, .timestamp}) AS commits
       WITH i, parent, collect(CASE WHEN mr IS NULL THEN NULL ELSE
         mr {.project, .iid, .title, .state, .sourceBranch, .targetBranch, .url, commits: commits}
       END) AS mrs
       RETURN i {.key, .title, .type, .status, .assignee, .resolved,
                 last_seen: toString(i.last_seen)} AS issue,
              parent.key AS parentKey,
              [m IN mrs WHERE m IS NOT NULL] AS mergeRequests`,
      { key: entryKey }
    );
    if (rows.length === 0) return { found: false };

    interface StoredIssueRow {
      issue: StoredIssue;
      parentKey: string | null;
      mergeRequests: Array<{ project?: string; iid: number; title?: string; state?: string; url?: string; commits: StoredCommit[] }>;
    }

    const items: StoredContextItem[] = [];
    const links: StoredTraceabilityLink[] = [];
    let stalest = Number.POSITIVE_INFINITY;
    for (const raw of rows as unknown as StoredIssueRow[]) {
      if (!raw.issue.resolved) continue;
      const seen = raw.issue.last_seen ? Date.parse(raw.issue.last_seen) : NaN;
      if (Number.isFinite(seen)) stalest = Math.min(stalest, seen);
      items.push({
        work_item: {
          id: raw.issue.key,
          type: raw.issue.type,
          title: raw.issue.title,
          status: raw.issue.status,
          assignee: raw.issue.assignee,
          parent_id: raw.parentKey ?? undefined,
        },
        merge_requests: raw.mergeRequests.map((mr) => ({
          id: mr.iid,
          project: mr.project,
          title: mr.title,
          state: mr.state,
          url: mr.url,
        })),
        commits: raw.mergeRequests.flatMap((mr) => mr.commits),
      });
      for (const mr of raw.mergeRequests) {
        links.push({ jira_key: raw.issue.key, merge_request_id: mr.iid });
      }
    }
    if (items.length === 0) return { found: false };

    return {
      found: true,
      entry: entryKey,
      items,
      traceability: { links },
      ageSeconds: Number.isFinite(stalest) ? Math.max(0, Math.round((Date.now() - stalest) / 1000)) : undefined,
    };
  }

  /** Node/relationship counts and freshness bounds — "how much does laToile remember?". */
  async stats(): Promise<GraphStatsResult> {
    const nodes = await this.deps.query(
      `MATCH (n)
       RETURN labels(n)[0] AS label, count(n) AS count,
              toString(min(n.first_seen)) AS oldest_first_seen,
              toString(max(n.last_seen)) AS newest_last_seen
       ORDER BY label`,
      {}
    );
    const relationships = await this.deps.query(
      `MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count ORDER BY type`,
      {}
    );
    return {
      nodes: nodes as unknown as GraphStatsResult['nodes'],
      relationships: relationships as unknown as GraphStatsResult['relationships'],
    };
  }

  async close(): Promise<void> {
    await this.deps.close?.();
  }
}

export interface KnowledgeGraphConnection {
  uri: string;
  user: string;
  password: string;
}

/** Builds a KnowledgeGraph on the real driver (lazy import, plain JS numbers). */
export async function createKnowledgeGraph(
  conn: KnowledgeGraphConnection,
  log: LogFn = () => {}
): Promise<KnowledgeGraph> {
  const neo4j = (await import('neo4j-driver')).default;
  const driver = neo4j.driver(conn.uri, neo4j.auth.basic(conn.user, conn.password), {
    disableLosslessIntegers: true,
  });
  const query: CypherQueryFn = async (cypher, params) => {
    const session = driver.session();
    try {
      const result = await session.run(cypher, params);
      return result.records.map((record) => record.toObject() as Record<string, unknown>);
    } finally {
      await session.close();
    }
  };
  return new KnowledgeGraph({ query, close: () => driver.close(), log });
}
