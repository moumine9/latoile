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

export interface KnownContextResult {
  found: boolean;
  issue?: Record<string, unknown>;
  neighbors?: Array<Record<string, unknown>>;
  /** Seconds since this issue was last refreshed from live sources. */
  ageSeconds?: number;
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
    const issue = row.issue as Record<string, unknown>;
    const lastSeen = typeof issue['last_seen'] === 'string' ? Date.parse(issue['last_seen']) : NaN;
    return {
      found: true,
      issue,
      neighbors: (row.neighbors as Array<Record<string, unknown> | null>).filter(
        (n): n is Record<string, unknown> => n !== null
      ),
      ageSeconds: Number.isFinite(lastSeen) ? Math.max(0, Math.round((Date.now() - lastSeen) / 1000)) : undefined,
    };
  }

  /**
   * Issues assigned to and MRs/commits authored by a person. Matches any
   * identity: canonical key, display name, Jira name, or GitLab username
   * (case/accent-insensitive substring).
   */
  async personActivity(name: string, sinceDays = 90): Promise<Record<string, unknown>> {
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
    return { matches: rows, sinceDays };
  }

  /** Node/relationship counts and freshness bounds — "how much does laToile remember?". */
  async stats(): Promise<Record<string, unknown>> {
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
    return { nodes, relationships };
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
