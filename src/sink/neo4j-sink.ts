/**
 * Neo4j implementation of GraphSink (see PLAN-NEO4J.md).
 *
 * Persists the raw traversal result — including commits and people that the
 * visualization deliberately drops — as an append-only knowledge graph:
 * MERGE on stable keys, `first_seen` set on create, `last_seen` refreshed on
 * every sighting, mutable properties overwritten with the latest non-null
 * values. Sibling relations are not persisted (derivable from shared parents).
 *
 * The class depends only on an injectable Cypher runner so unit tests can
 * assert queries/params without a database; `createNeo4jSink` wires it to the
 * real driver (lazily imported so nothing loads when Neo4j is unconfigured).
 */
import { encodeStoredComment } from './comment-codec.js';
import type { GraphSink } from './graph-sink.js';
import { isDisplayName, personKey, PERSON_SCHEMA_VERSION } from './person-identity.js';
import type { IssueNode, LogFn, Relation, TraversalResult } from '../types.js';

/** Executes one Cypher statement; injectable for tests. */
export type CypherRunFn = (query: string, params: Record<string, unknown>) => Promise<void>;

export type Neo4jSinkDeps = {
  run: CypherRunFn;
  close?: () => Promise<void>;
  log?: LogFn;
}

const CONSTRAINTS = [
  'CREATE CONSTRAINT issue_key IF NOT EXISTS FOR (n:Issue) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT mr_id IF NOT EXISTS FOR (n:MergeRequest) REQUIRE (n.project, n.iid) IS UNIQUE',
  'CREATE CONSTRAINT commit_sha IF NOT EXISTS FOR (n:Commit) REQUIRE n.sha IS UNIQUE',
  'CREATE CONSTRAINT person_key IF NOT EXISTS FOR (n:Person) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT doc_url IF NOT EXISTS FOR (n:Doc) REQUIRE n.url IS UNIQUE',
  'CREATE CONSTRAINT project_path IF NOT EXISTS FOR (n:Project) REQUIRE n.path IS UNIQUE',
  'CREATE CONSTRAINT file_key IF NOT EXISTS FOR (n:File) REQUIRE (n.project, n.path) IS UNIQUE',
];

/**
 * Person schema migration. People are derived data, so when the key
 * derivation changes (PERSON_SCHEMA_VERSION bump) or nodes predate keys
 * entirely, the stale nodes are simply dropped — the next ingest of each
 * ticket re-creates them under the current canonical keys.
 */
const PERSON_MIGRATION = [
  'DROP CONSTRAINT person_name IF EXISTS',
  `MATCH (p:Person) WHERE p.key IS NULL OR coalesce(p.schemaVersion, 1) < ${PERSON_SCHEMA_VERSION} DETACH DELETE p`,
];

/** Maps a traversal relation to a persisted relationship (or null to skip). */
function relationToEdge(rel: Relation): { from: string; to: string; type: string; linkType?: string } | null {
  switch (rel.relation) {
    case 'parent':
      // from = child, to = parent → parent PARENT_OF child.
      return { from: rel.to, to: rel.from, type: 'PARENT_OF' };
    case 'subtask':
      return { from: rel.from, to: rel.to, type: 'HAS_SUBTASK' };
    case 'link':
      return rel.linkType
        ? { from: rel.from, to: rel.to, type: 'LINKS_TO', linkType: rel.linkType }
        : { from: rel.from, to: rel.to, type: 'LINKS_TO' };
    case 'mention':
      return { from: rel.from, to: rel.to, type: 'MENTIONS' };
    case 'sibling':
      // Derivable from shared parents; persisting would re-create the clique.
      return null;
    default:
      return null;
  }
}

type IssueParam = {
  key: string;
  title: string | null;
  type: string | null;
  status: string | null;
  assignee: string | null;
  resolved: boolean;
  /** Tri-state: true/false from Jira's dev-status field, null = unknown. */
  hasGitlabData: boolean | null;
  /** Tri-state: true/false when actively fetched this run, null = not fetched (placeholder). */
  missing: boolean | null;
  /** JSON-encoded comments (see comment-codec); null = not fetched this run. */
  comments: string[] | null;
}

/** Comments persisted per issue; long threads are capped at the most recent. */
const MAX_STORED_COMMENTS = 20;

function issueParam(node: IssueNode): IssueParam {
  return {
    key: node.key,
    title: node.title ?? null,
    type: node.type ?? null,
    status: node.status ?? null,
    assignee: node.assignee ?? null,
    resolved: Boolean(node.resolved),
    hasGitlabData: node.hasGitlabData ?? null,
    missing: node.missing ?? null,
    comments: node.comments
      ? node.comments.slice(-MAX_STORED_COMMENTS).map(encodeStoredComment)
      : null,
  };
}

export class Neo4jSink implements GraphSink {
  private deps: Neo4jSinkDeps;
  private log: LogFn;
  private constraintsEnsured = false;

  constructor(deps: Neo4jSinkDeps) {
    this.deps = deps;
    this.log = deps.log ?? (() => {});
  }

  private async ensureConstraints(): Promise<void> {
    if (this.constraintsEnsured) return;
    for (const statement of PERSON_MIGRATION) {
      await this.deps.run(statement, {});
    }
    for (const constraint of CONSTRAINTS) {
      await this.deps.run(constraint, {});
    }
    this.constraintsEnsured = true;
  }

  async ingest(result: TraversalResult): Promise<void> {
    await this.ensureConstraints();
    const run = this.deps.run;
    const nodes = [...result.issues.values()];

    // Issues — placeholders are persisted too (resolved: false marks the
    // unexplored frontier); coalesce keeps previously-known values when a
    // later sighting is only a placeholder.
    await run(
      `UNWIND $issues AS i
       MERGE (n:Issue {key: i.key})
       ON CREATE SET n.first_seen = datetime()
       SET n.last_seen = datetime(),
           n.title = coalesce(i.title, n.title),
           n.type = coalesce(i.type, n.type),
           n.status = coalesce(i.status, n.status),
           n.assignee = coalesce(i.assignee, n.assignee),
           n.resolved = coalesce(n.resolved, false) OR i.resolved,
           n.hasGitlabData = coalesce(i.hasGitlabData, n.hasGitlabData),
           n.comments = coalesce(i.comments, n.comments),
           n.missing = CASE WHEN i.missing = true THEN true
                            WHEN i.resolved THEN false
                            ELSE coalesce(n.missing, false) END`,
      { issues: nodes.map(issueParam) }
    );

    // Jira ↔ Jira relationships, grouped per type (Cypher cannot parameterize
    // relationship types).
    const edgesByType = new Map<string, Array<{ from: string; to: string; linkType?: string }>>();
    for (const rel of result.relations) {
      const edge = relationToEdge(rel);
      if (!edge) continue;
      const bucket = edgesByType.get(edge.type) ?? [];
      bucket.push({ from: edge.from, to: edge.to, linkType: edge.linkType });
      edgesByType.set(edge.type, bucket);
    }
    for (const [type, edges] of edgesByType) {
      await run(
        `UNWIND $edges AS e
         MATCH (a:Issue {key: e.from}), (b:Issue {key: e.to})
         MERGE (a)-[r:${type}]->(b)
         SET r.last_seen = datetime(), r.linkType = coalesce(e.linkType, r.linkType)`,
        { edges }
      );
    }

    // Assignees (Jira display names → canonical person key).
    await run(
      `UNWIND $assignments AS a
       MATCH (i:Issue {key: a.key})
       MERGE (p:Person {key: a.personKey})
       ON CREATE SET p.first_seen = datetime()
       SET p.last_seen = datetime(),
           p.schemaVersion = ${PERSON_SCHEMA_VERSION},
           p.name = coalesce(p.name, a.assignee),
           p.jiraName = a.assignee
       MERGE (i)-[r:ASSIGNED_TO]->(p)
       SET r.last_seen = datetime()`,
      {
        assignments: nodes
          .filter((n): n is IssueNode & { assignee: string } => Boolean(n.assignee))
          .map((n) => ({ key: n.key, assignee: n.assignee, personKey: personKey(n.assignee) })),
      }
    );

    // Merge requests (with author) and their commits (with author).
    const mrs: Array<Record<string, unknown>> = [];
    const commits: Array<Record<string, unknown>> = [];
    const files: Array<{ project: string; iid: number; path: string }> = [];
    for (const node of nodes) {
      for (const mr of node.gitlab?.mergeRequests ?? []) {
        const project = mr.project ?? 'default';
        mrs.push({
          issueKey: node.key,
          project,
          projectId: mr.projectId ?? null,
          iid: mr.iid,
          title: mr.title ?? null,
          state: mr.state ?? null,
          sourceBranch: mr.sourceBranch ?? null,
          targetBranch: mr.targetBranch ?? null,
          url: mr.url ?? null,
          author: mr.author ?? null,
          authorKey: mr.author ? personKey(mr.author) : null,
        });
        for (const path of mr.changedFiles ?? []) {
          files.push({ project, iid: mr.iid, path });
        }
        for (const commit of mr.commits ?? []) {
          commits.push({
            project,
            iid: mr.iid,
            sha: commit.sha,
            title: commit.title ?? null,
            timestamp: commit.timestamp ?? null,
            author: commit.author ?? null,
            authorKey: commit.author ? personKey(commit.author) : null,
            authorIsDisplay: commit.author ? isDisplayName(commit.author) : false,
          });
        }
      }
    }
    await run(
      `UNWIND $mrs AS m
       MATCH (i:Issue {key: m.issueKey})
       MERGE (mr:MergeRequest {project: m.project, iid: m.iid})
       ON CREATE SET mr.first_seen = datetime()
       SET mr.last_seen = datetime(),
           mr.title = coalesce(m.title, mr.title),
           mr.state = coalesce(m.state, mr.state),
           mr.sourceBranch = coalesce(m.sourceBranch, mr.sourceBranch),
           mr.targetBranch = coalesce(m.targetBranch, mr.targetBranch),
           mr.url = coalesce(m.url, mr.url)
       MERGE (i)-[hr:HAS_MR]->(mr)
       SET hr.last_seen = datetime()
       // Projects are first-class: work items span several repos
       // (microservices + microfrontends) and "what else touched this repo"
       // is a core query.
       MERGE (proj:Project {path: m.project})
       ON CREATE SET proj.first_seen = datetime()
       SET proj.last_seen = datetime(),
           proj.gitlabId = coalesce(m.projectId, proj.gitlabId)
       MERGE (mr)-[ip:IN_PROJECT]->(proj)
       SET ip.last_seen = datetime()
       FOREACH (k IN CASE WHEN m.authorKey IS NULL THEN [] ELSE [m.authorKey] END |
         MERGE (p:Person {key: k})
         ON CREATE SET p.first_seen = datetime()
         SET p.last_seen = datetime(),
             p.schemaVersion = ${PERSON_SCHEMA_VERSION},
             p.gitlabUsername = m.author,
             p.name = coalesce(p.name, m.author)
         MERGE (mr)-[ar:AUTHORED_BY]->(p)
         SET ar.last_seen = datetime())`,
      { mrs }
    );
    await run(
      `UNWIND $commits AS c
       MATCH (mr:MergeRequest {project: c.project, iid: c.iid})
       MERGE (cm:Commit {sha: c.sha})
       ON CREATE SET cm.first_seen = datetime()
       SET cm.last_seen = datetime(),
           cm.title = coalesce(c.title, cm.title),
           cm.timestamp = coalesce(c.timestamp, cm.timestamp)
       MERGE (mr)-[hc:HAS_COMMIT]->(cm)
       SET hc.last_seen = datetime()
       FOREACH (k IN CASE WHEN c.authorKey IS NULL THEN [] ELSE [c.authorKey] END |
         MERGE (p:Person {key: k})
         ON CREATE SET p.first_seen = datetime()
         SET p.last_seen = datetime(),
             p.schemaVersion = ${PERSON_SCHEMA_VERSION},
             // A display name is the best label we ever get — let it win.
             p.name = CASE WHEN c.authorIsDisplay THEN c.author ELSE coalesce(p.name, c.author) END
         MERGE (cm)-[ar:AUTHORED_BY]->(p)
         SET ar.last_seen = datetime())`,
      { commits }
    );

    // Files touched (opt-in — only populated when file-diff ingestion is enabled).
    await run(
      `UNWIND $files AS f
       MATCH (mr:MergeRequest {project: f.project, iid: f.iid})
       MERGE (file:File {project: f.project, path: f.path})
       ON CREATE SET file.first_seen = datetime()
       SET file.last_seen = datetime()
       MERGE (mr)-[t:TOUCHES]->(file)
       SET t.last_seen = datetime()`,
      { files }
    );

    // Documentation links.
    await run(
      `UNWIND $docs AS d
       MATCH (i:Issue {key: d.issueKey})
       MERGE (doc:Doc {url: d.url})
       ON CREATE SET doc.first_seen = datetime()
       SET doc.last_seen = datetime(),
           doc.source = coalesce(d.source, doc.source),
           doc.title = coalesce(d.title, doc.title)
       MERGE (i)-[r:DOCUMENTED_BY]->(doc)
       SET r.last_seen = datetime()`,
      {
        docs: nodes.flatMap((n) =>
          (n.documentation ?? []).map((d) => ({
            issueKey: n.key,
            url: d.url,
            source: d.source ?? null,
            title: d.title ?? null,
          }))
        ),
      }
    );

    this.log(
      `Knowledge graph updated: ${nodes.length} issues, ${mrs.length} MRs, ${commits.length} commits`
    );
  }

  async close(): Promise<void> {
    await this.deps.close?.();
  }
}

export type Neo4jConnection = {
  uri: string;
  user: string;
  password: string;
}

/**
 * Builds a Neo4jSink backed by the official driver. The driver is imported
 * lazily so latoile never loads it when Neo4j is not configured.
 */
export async function createNeo4jSink(conn: Neo4jConnection, log: LogFn = () => {}): Promise<Neo4jSink> {
  const neo4j = (await import('neo4j-driver')).default;
  const driver = neo4j.driver(conn.uri, neo4j.auth.basic(conn.user, conn.password));
  const run: CypherRunFn = async (query, params) => {
    const session = driver.session();
    try {
      await session.run(query, params);
    } finally {
      await session.close();
    }
  };
  return new Neo4jSink({ run, close: () => driver.close(), log });
}
