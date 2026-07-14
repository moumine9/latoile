import test from 'node:test';
import assert from 'node:assert/strict';
import { Neo4jSink, type CypherRunFn } from '../src/sink/neo4j-sink.js';
import { buildContextGraph } from '../src/pipeline.js';
import type { GraphSink } from '../src/sink/graph-sink.js';
import type { IssueNode, TraversalResult } from '../src/types.js';

type RecordedCall = {
  query: string;
  params: Record<string, unknown>;
}

function makeSink(): { sink: Neo4jSink; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: CypherRunFn = async (query, params) => {
    calls.push({ query, params });
  };
  return { sink: new Neo4jSink({ run }), calls };
}

function issueNode(key: string, extra: Partial<IssueNode> = {}): IssueNode {
  return {
    key,
    resolved: true,
    depth: 0,
    subtasks: [],
    links: [],
    mentions: [],
    documentation: [],
    gitlab: { mergeRequests: [] },
    ...extra,
  } as IssueNode;
}

function traversal(): TraversalResult {
  const issues = new Map<string, IssueNode>();
  issues.set('PV2-1', issueNode('PV2-1', {
    title: 'Entry',
    assignee: 'Alice',
    gitlab: {
      mergeRequests: [
        {
          iid: 6606,
          project: 'grp/proj',
          projectId: 4242,
          title: 'MR title',
          state: 'merged',
          sourceBranch: 'fix/pv2-1',
          targetBranch: 'main',
          url: 'https://gitlab.com/grp/proj/-/merge_requests/6606',
          author: 'bob',
          commits: [{ sha: 'abc123', shortSha: 'abc123', title: 'c1', author: 'bob', timestamp: 't' }],
        },
      ],
    },
    documentation: [{ source: 'confluence', title: 'Doc', url: 'https://c/1' }],
  }));
  issues.set('EPIC-1', issueNode('EPIC-1', { resolved: false }));
  return {
    entry: 'PV2-1',
    issues,
    relations: [
      { from: 'PV2-1', to: 'EPIC-1', relation: 'parent', strength: 'strong' },
      { from: 'PV2-1', to: 'PV2-2', relation: 'mention', strength: 'weak' },
      { from: 'PV2-1', to: 'PV2-3', relation: 'sibling', strength: 'strong' },
    ],
    stats: { fetched: 1, total: 2, capped: false, maxDepthReached: false, maxDepth: 1, maxNodes: 50 },
  };
}

test('Neo4jSink creates constraints and runs the person migration once', async () => {
  const { sink, calls } = makeSink();
  await sink.ingest(traversal());
  const constraintCount = calls.filter((c) => c.query.startsWith('CREATE CONSTRAINT')).length;
  assert.equal(constraintCount, 6);
  assert.equal(calls.filter((c) => c.query.startsWith('DROP CONSTRAINT person_name')).length, 1);
  assert.equal(calls.filter((c) => c.query.includes('DETACH DELETE p')).length, 1);
  // Migration also drops people written under an older key derivation.
  assert.equal(calls.filter((c) => c.query.includes('p.schemaVersion, 1) <')).length, 1);
  await sink.ingest(traversal());
  const after = calls.filter((c) => c.query.startsWith('CREATE CONSTRAINT')).length;
  assert.equal(after, 6);
});

test('Neo4jSink merges people on the canonical identity key', async () => {
  const { sink, calls } = makeSink();
  const t = traversal();
  const entry = t.issues.get('PV2-1');
  assert.ok(entry);
  entry.assignee = 'Karianne Verville-Paris';
  const mr = entry.gitlab?.mergeRequests[0];
  assert.ok(mr);
  mr.author = 'kvervilleparis';
  const commit = mr.commits?.[0];
  assert.ok(commit);
  commit.author = 'Karianne Verville-Paris';
  await sink.ingest(t);

  const assigneeCall = calls.find((c) => c.query.includes(':ASSIGNED_TO'));
  const mrCall = calls.find((c) => c.query.includes('MERGE (mr:MergeRequest'));
  const commitCall = calls.find((c) => c.query.includes('MERGE (cm:Commit'));
  const assignment = (assigneeCall?.params.assignments as Array<{ personKey: string }>)[0];
  const mrParam = (mrCall?.params.mrs as Array<{ authorKey: string }>)[0];
  const commitParam = (commitCall?.params.commits as Array<{ authorKey: string; authorIsDisplay: boolean }>)[0];
  // All three sources resolve to the same Person node.
  assert.equal(assignment?.personKey, 'kvervilleparis');
  assert.equal(mrParam?.authorKey, 'kvervilleparis');
  assert.equal(commitParam?.authorKey, 'kvervilleparis');
  assert.equal(commitParam?.authorIsDisplay, true);
});

test('Neo4jSink upserts issues including unresolved placeholders', async () => {
  const { sink, calls } = makeSink();
  await sink.ingest(traversal());
  const issueCall = calls.find((c) => c.query.includes('MERGE (n:Issue'));
  assert.ok(issueCall);
  const issues = issueCall.params.issues as Array<{ key: string; resolved: boolean }>;
  assert.deepEqual(
    issues.map((i) => [i.key, i.resolved]),
    [['PV2-1', true], ['EPIC-1', false]]
  );
  assert.match(issueCall.query, /first_seen/);
  assert.match(issueCall.query, /last_seen/);
});

test('Neo4jSink marks issues missing when a live fetch actively found nothing', async () => {
  const { sink, calls } = makeSink();
  const t = traversal();
  t.issues.set('PV2-1', issueNode('PV2-1', { resolved: false, missing: true }));
  await sink.ingest(t);
  const issueCall = calls.find((c) => c.query.includes('MERGE (n:Issue'));
  assert.ok(issueCall);
  const issues = issueCall.params.issues as Array<{ key: string; missing: boolean | null }>;
  assert.deepEqual(
    issues.map((i) => [i.key, i.missing]),
    [['PV2-1', true], ['EPIC-1', null]]
  );
  assert.match(issueCall.query, /n\.missing = CASE/);
});

test('Neo4jSink maps parent direction, keeps mentions, skips siblings', async () => {
  const { sink, calls } = makeSink();
  await sink.ingest(traversal());
  const parentCall = calls.find((c) => c.query.includes(':PARENT_OF'));
  assert.ok(parentCall);
  // parent relation from=child to=parent must persist as (parent)-[:PARENT_OF]->(child)
  assert.deepEqual(parentCall.params.edges, [{ from: 'EPIC-1', to: 'PV2-1', linkType: undefined }]);
  assert.ok(calls.some((c) => c.query.includes(':MENTIONS')));
  assert.ok(!calls.some((c) => c.query.includes('SIBLING')));
});

test('Neo4jSink persists MRs, commits, people, and docs', async () => {
  const { sink, calls } = makeSink();
  await sink.ingest(traversal());

  const mrCall = calls.find((c) => c.query.includes('MERGE (mr:MergeRequest'));
  assert.ok(mrCall);
  const mrs = mrCall.params.mrs as Array<{ project: string; iid: number; author: string | null }>;
  assert.equal(mrs[0]?.project, 'grp/proj');
  assert.equal(mrs[0]?.author, 'bob');

  const commitCall = calls.find((c) => c.query.includes('MERGE (cm:Commit'));
  assert.ok(commitCall);
  assert.equal((commitCall.params.commits as Array<{ sha: string }>)[0]?.sha, 'abc123');

  const assigneeCall = calls.find((c) => c.query.includes(':ASSIGNED_TO'));
  assert.ok(assigneeCall);
  assert.deepEqual(assigneeCall.params.assignments, [{ key: 'PV2-1', assignee: 'Alice', personKey: 'alice' }]);

  const docCall = calls.find((c) => c.query.includes('MERGE (doc:Doc'));
  assert.ok(docCall);
  assert.equal((docCall.params.docs as Array<{ url: string }>)[0]?.url, 'https://c/1');
});

test('pipeline feeds the sink and survives sink failures', async () => {
  const clients = {
    acli: { fetchIssue: async (key: string) => ({ key, subtasks: [], links: [], mentions: [], documentation: [] }) },
    glab: { fetchForKey: async () => ({ mergeRequests: [] }) },
  };

  let ingested: TraversalResult | undefined;
  const okSink: GraphSink = {
    ingest: async (r) => {
      ingested = r;
    },
    close: async () => {},
  };
  await buildContextGraph('PV2-1', { clients: clients as never, sink: okSink, maxDepth: 0 });
  assert.ok(ingested);
  assert.equal(ingested.entry, 'PV2-1');

  const logs: string[] = [];
  const failingSink: GraphSink = {
    ingest: async () => {
      throw new Error('bolt down');
    },
    close: async () => {},
  };
  const result = await buildContextGraph('PV2-1', {
    clients: clients as never,
    sink: failingSink,
    maxDepth: 0,
    log: (m) => logs.push(m),
  });
  assert.ok(result.graph.nodes.length >= 1);
  assert.ok(logs.some((l) => l.includes('Knowledge graph write failed')));
});
