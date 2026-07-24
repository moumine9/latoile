import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeGraph, type CypherQueryFn } from '../src/sink/knowledge-graph.js';
import {
  findConnectionTool,
  getContextTool,
  graphStatsTool,
  knownContextTool,
  personActivityTool,
  recordInsightTool,
} from '../src/mcp/server.js';

function makeGraph(rows: Array<Record<string, unknown>> | Array<Array<Record<string, unknown>>>): {
  graph: KnowledgeGraph;
  queries: Array<{ query: string; params: Record<string, unknown> }>;
} {
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
  let call = 0;
  const query: CypherQueryFn = async (q, params) => {
    queries.push({ query: q, params });
    const batch = rows[call] ?? rows;
    call += 1;
    return Array.isArray(batch) ? (batch as Array<Record<string, unknown>>) : [];
  };
  return { graph: new KnowledgeGraph({ query }), queries };
}

test('findConnection returns the path and parameterizes both keys', async () => {
  const { graph, queries } = makeGraph([
    [{ nodes: [{ label: 'Issue', id: 'PV2-1', title: 'a' }, { label: 'Issue', id: 'PV2-2', title: 'b' }], relationships: ['MENTIONS'] }],
  ] as never);
  const result = await graph.findConnection('PV2-1', 'PV2-2');
  assert.equal(result.found, true);
  assert.equal(result.relationships[0], 'MENTIONS');
  assert.match(queries[0]?.query ?? '', /shortestPath/);
  assert.deepEqual(queries[0]?.params, { a: 'PV2-1', b: 'PV2-2' });
});

test('findConnection reports found: false when no path exists', async () => {
  const { graph } = makeGraph([[]] as never);
  const result = await graph.findConnection('PV2-1', 'PV2-2');
  assert.deepEqual(result, { found: false, nodes: [], relationships: [] });
});

test('knownContext computes ageSeconds from last_seen and filters null neighbors', async () => {
  const lastSeen = new Date(Date.now() - 120_000).toISOString();
  const { graph } = makeGraph([
    [{ issue: { key: 'PV2-1', last_seen: lastSeen }, neighbors: [null, { relation: 'HAS_MR', label: 'MergeRequest' }] }],
    [],
  ] as never);
  const result = await graph.knownContext('PV2-1');
  assert.equal(result.found, true);
  assert.equal(result.neighbors?.length, 1);
  assert.ok((result.ageSeconds ?? 0) >= 119 && (result.ageSeconds ?? 0) <= 130);
  assert.deepEqual(result.insights, []);
});

test('knownContext excludes :Insight nodes from the generic neighbor list', async () => {
  const { graph, queries } = makeGraph([
    [{ issue: { key: 'PV2-1', last_seen: new Date().toISOString() }, neighbors: [] }],
    [],
  ] as never);
  await graph.knownContext('PV2-1');
  assert.match(queries[0]?.query ?? '', /NOT nb:Insight/);
});

test('recordInsight creates an Insight node and returns its id', async () => {
  const recordedAt = new Date().toISOString();
  const { graph, queries } = makeGraph([
    [{ id: 'ignored', recorded_at: recordedAt }],
  ] as never);
  const result = await graph.recordInsight({
    issueKey: 'PV2-18107',
    rootCause: 'nested-route oldLocation broke the summary-page regex',
    ruledOut: ['query-string regex', 'computeShouldBlock asymmetry'],
    entities: [{ name: 'Bruno Parent Pichette', role: 'reporter' }],
    relevantComments: [{ commentId: 'c1', relevance: 'high', why: 'names the exact repro' }],
  });
  assert.equal(result.found, true);
  assert.equal(result.recorded_at, recordedAt);
  assert.ok(result.id, 'a generated id is returned');
  const call = queries[0];
  assert.ok(call);
  assert.equal(call.params.issueKey, 'PV2-18107');
  assert.equal(call.params.rootCause, 'nested-route oldLocation broke the summary-page regex');
  assert.deepEqual(call.params.ruledOut, ['query-string regex', 'computeShouldBlock asymmetry']);
  assert.match(call.query, /CREATE \(ins:Insight/);
  assert.match(call.query, /MERGE \(ins\)-\[:RECORDED_ON\]->\(i\)/);
  // entities/relevantComments are JSON-encoded (Neo4j properties can't hold arrays of maps).
  assert.deepEqual(JSON.parse(call.params.entities as string), [{ name: 'Bruno Parent Pichette', role: 'reporter' }]);
});

test('recordInsight reports found: false without writing when the issue is unknown', async () => {
  const { graph } = makeGraph([[]] as never);
  const result = await graph.recordInsight({ issueKey: 'PV2-NOPE', rootCause: 'x' });
  assert.deepEqual(result, { found: false });
});

test('insightsForIssue decodes entities/relevantComments and orders newest first', async () => {
  const { graph, queries } = makeGraph([
    [
      {
        insight: {
          id: 'i2',
          rootCause: 'cause two',
          ruledOut: [],
          entities: JSON.stringify([{ name: 'Alice' }]),
          relevantComments: JSON.stringify([{ commentId: 'c2', relevance: 'low' }]),
          recorded_at: '2026-07-23T12:00:00.000Z',
        },
      },
    ],
  ] as never);
  const insights = await graph.insightsForIssue('PV2-1');
  assert.equal(insights.length, 1);
  assert.equal(insights[0]?.rootCause, 'cause two');
  assert.deepEqual(insights[0]?.entities, [{ name: 'Alice', role: undefined }]);
  assert.deepEqual(insights[0]?.relevantComments, [{ commentId: 'c2', relevance: 'low', why: undefined }]);
  assert.match(queries[0]?.query ?? '', /ORDER BY ins\.recorded_at DESC/);
});

test('personActivity passes the since cutoff and name', async () => {
  const { graph, queries } = makeGraph([[]] as never);
  await graph.personActivity('alice', 30);
  const call = queries[0];
  assert.ok(call);
  assert.equal(call.params.name, 'alice');
  const since = Date.parse(call.params.since as string);
  const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(since - expected) < 60_000);
});

test('staleIssueKeys parameterizes staleness/limit and returns keys oldest-first', async () => {
  const { graph, queries } = makeGraph([
    [{ key: 'PV2-1' }, { key: 'PV2-2' }],
  ] as never);
  const keys = await graph.staleIssueKeys(1440, 20);
  assert.deepEqual(keys, ['PV2-1', 'PV2-2']);
  const call = queries[0];
  assert.ok(call);
  assert.deepEqual(call.params, { staleMinutes: 1440, limit: 20 });
  assert.match(call.query, /ORDER BY i\.last_seen ASC/);
});

test('knowledge-graph tools error cleanly when unconfigured', async (t) => {
  const { config } = await import('../src/config.js');
  if (config.neo4jUri) {
    t.skip('LATOILE_NEO4J_URI is configured in this environment');
    return;
  }
  for (const result of [
    await findConnectionTool('PV2-1', 'PV2-2'),
    await knownContextTool('PV2-1'),
    await personActivityTool('alice'),
    await graphStatsTool(),
  ]) {
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /not configured/);
  }
});

test('knowledge-graph tools return structured content with an injected graph', async () => {
  const { graph } = makeGraph([
    [{ label: 'Issue', count: 9, oldest_first_seen: 't0', newest_last_seen: 't1' }],
    [{ type: 'HAS_MR', count: 4 }],
  ] as never);
  const result = await graphStatsTool(graph);
  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as { nodes: Array<{ label: string }>; relationships: Array<{ type: string }> };
  assert.equal(structured.nodes[0]?.label, 'Issue');
  assert.equal(structured.relationships[0]?.type, 'HAS_MR');
});

test('storedContext rebuilds items, links, and stalest-issue age', async () => {
  const fresh = new Date(Date.now() - 60_000).toISOString();
  const stale = new Date(Date.now() - 600_000).toISOString();
  const { graph } = makeGraph([
    [
      {
        issue: { key: 'PV2-1', title: 'Entry', status: 'Done', resolved: true, last_seen: fresh },
        parentKey: 'EPIC-1',
        mergeRequests: [{ project: 'g/p', iid: 7, title: 'mr', state: 'merged', commits: [{ sha: 'abc' }] }],
      },
      {
        issue: { key: 'PV2-2', title: 'Older sibling', resolved: true, last_seen: stale },
        parentKey: null,
        mergeRequests: [],
      },
      { issue: { key: 'PV2-3', resolved: false, last_seen: fresh }, parentKey: null, mergeRequests: [] },
    ],
  ] as never);
  const stored = await graph.storedContext('PV2-1', 1);
  assert.equal(stored.found, true);
  const items = stored.items as Array<{ work_item: { id: string; parent_id?: string } }>;
  // Unresolved placeholders are excluded, resolved issues kept.
  assert.deepEqual(items.map((i) => i.work_item.id), ['PV2-1', 'PV2-2']);
  assert.equal(items[0]?.work_item.parent_id, 'EPIC-1');
  const links = (stored.traceability as { links: Array<{ merge_request_id: number }> }).links;
  assert.equal(links[0]?.merge_request_id, 7);
  // Age reflects the stalest resolved issue (~600s), not the freshest.
  assert.ok((stored.ageSeconds ?? 0) > 500 && (stored.ageSeconds ?? 0) < 700);
});

test('storedContext with depth 0 skips the neighborhood expansion', async () => {
  const { graph, queries } = makeGraph([
    [{ issue: { key: 'PV2-1', resolved: true, last_seen: new Date().toISOString() }, parentKey: null, mergeRequests: [] }],
  ] as never);
  await graph.storedContext('PV2-1', 0);
  const query = queries[0]?.query ?? '';
  assert.ok(!query.includes('OPTIONAL MATCH (entry)-[:PARENT_OF'), 'depth 0 must not expand the neighborhood');
});

test('storedContext aggregates repositories per item and for the context', async () => {
  const fresh = new Date().toISOString();
  const { graph } = makeGraph([
    [
      {
        issue: { key: 'PV2-1', resolved: true, last_seen: fresh },
        parentKey: null,
        mergeRequests: [
          { project: 'grp/backend-svc', iid: 1, commits: [] },
          { project: 'grp/frontend-mfe', iid: 2, commits: [] },
        ],
      },
      {
        issue: { key: 'PV2-2', resolved: true, last_seen: fresh },
        parentKey: null,
        mergeRequests: [{ project: 'grp/backend-svc', iid: 3, commits: [] }],
      },
    ],
  ] as never);
  const stored = await graph.storedContext('PV2-1', 1);
  assert.deepEqual(stored.items?.[0]?.repositories, ['grp/backend-svc', 'grp/frontend-mfe']);
  assert.deepEqual(stored.repositories, ['grp/backend-svc', 'grp/frontend-mfe']);
});

test('projectActivity matches project paths case-insensitively', async () => {
  const { graph, queries } = makeGraph([
    [{ project: { path: 'grp/fee-matrix', gitlabId: 42 }, issues: [{ key: 'PV2-9' }], mergeRequests: [{ iid: 637 }] }],
  ] as never);
  const result = await graph.projectActivity('Fee-Matrix', 30);
  assert.equal(result.matches[0]?.project.path, 'grp/fee-matrix');
  assert.match(queries[0]?.query ?? '', /IN_PROJECT/);
  assert.equal(queries[0]?.params.path, 'Fee-Matrix');
});

test('storedContext caps items at maxNodes with the entry always kept', async () => {
  const fresh = new Date().toISOString();
  const row = (key: string) => ({ issue: { key, resolved: true, last_seen: fresh }, parentKey: null, mergeRequests: [] });
  // Entry deliberately last in the result rows to prove it survives the cut.
  const { graph } = makeGraph([[row('PV2-2'), row('PV2-3'), row('PV2-4'), row('PV2-1')]] as never);
  const stored = await graph.storedContext('PV2-1', 1, 2);
  const keys = stored.items?.map((i) => i.work_item.id);
  assert.equal(keys?.length, 2);
  assert.equal(keys?.[0], 'PV2-1');
});

test('storedContext surfaces a traversal block; node_cap_hit flips when maxNodes truncates', async () => {
  const fresh = new Date().toISOString();
  const row = (key: string) => ({ issue: { key, resolved: true, last_seen: fresh }, parentKey: null, mergeRequests: [] });
  const rows = [row('PV2-1'), row('PV2-2'), row('PV2-3')];

  // Cap below the neighborhood size → node_cap_hit true, counts reflect the cut.
  const capped = (await makeGraph([rows] as never).graph.storedContext('PV2-1', 1, 2)).traversal;
  assert.ok(capped, 'stored payload must carry a traversal block (parity with live)');
  assert.equal(capped.node_cap_hit, true);
  assert.equal(capped.nodes_fetched, 2, 'items capped at maxNodes');
  assert.equal(capped.total_nodes, 3, 'total reflects the discovered neighborhood');
  assert.equal(capped.max_nodes, 2);
  // Depth fields are intentionally omitted on the stored path (can't be computed).
  assert.equal('depth_reached' in capped, false);
  assert.equal('depth_limit_hit' in capped, false);

  // Cap above the neighborhood size → not truncated.
  const full = (await makeGraph([rows] as never).graph.storedContext('PV2-1', 1, 100)).traversal;
  assert.equal(full?.node_cap_hit, false);
  assert.equal(full?.nodes_fetched, 3);
});

test('getContextTool serves fresh stored context without running the pipeline', async () => {
  const fresh = new Date(Date.now() - 30_000).toISOString();
  const { graph } = makeGraph([
    [{ issue: { key: 'PV2-1', resolved: true, last_seen: fresh }, parentKey: null, mergeRequests: [] }],
  ] as never);
  let ran = false;
  const result = await getContextTool(
    { jiraKey: 'PV2-1', maxAgeSeconds: 3600 },
    async () => {
      ran = true;
      throw new Error('unreachable');
    },
    undefined,
    graph
  );
  assert.equal(ran, false);
  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as { source: string; entry: string };
  assert.equal(structured.source, 'knowledge_graph');
  assert.equal(structured.entry, 'PV2-1');
});

test('getContextTool falls back to live when stored data is too old', async () => {
  const stale = new Date(Date.now() - 7200_000).toISOString();
  const { graph } = makeGraph([
    [{ issue: { key: 'PV2-1', resolved: true, last_seen: stale }, parentKey: null, mergeRequests: [] }],
  ] as never);
  const live = {
    graph: { entry: 'PV2-1', stats: { fetched: 1, total: 1, capped: false, maxDepthReached: false, maxDepth: 1, maxNodes: 50, nodes: 0, edges: 0 }, nodes: [], edges: [] },
    context: { entry: 'PV2-1', items: [], repositories: [], traceability: { links: [] } },
  };
  const result = await getContextTool({ jiraKey: 'PV2-1', maxAgeSeconds: 60 }, async () => live, undefined, graph);
  const structured = result.structuredContent as { source: string };
  assert.equal(structured.source, 'live');
});

test('findConnectionTool validates keys before querying', async () => {
  const result = await findConnectionTool('nope', 'PV2-2');
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /valid Jira keys/);
});

test('recordInsightTool validates the Jira key before querying', async () => {
  const result = await recordInsightTool({ jiraKey: 'nope', rootCause: 'x' });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /valid Jira key/);
});

test('recordInsightTool rejects an empty payload', async () => {
  const result = await recordInsightTool({ jiraKey: 'PV2-1' });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /at least one of/);
});

test('recordInsightTool succeeds with an injected graph', async () => {
  const recordedAt = new Date().toISOString();
  const { graph, queries } = makeGraph([[{ id: 'abc', recorded_at: recordedAt }]] as never);
  const result = await recordInsightTool(
    { jiraKey: 'pv2-18107', rootCause: 'nested-route regex gap', ruledOut: ['query string'] },
    graph
  );
  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as { found: boolean; id: string; recorded_at: string };
  assert.equal(structured.found, true);
  assert.equal(structured.id, 'abc');
  assert.equal(structured.recorded_at, recordedAt);
  // Jira key is uppercased before hitting the graph, like every other tool.
  assert.equal(queries[0]?.params.issueKey, 'PV2-18107');
});

test('recordInsightTool reports found: false with guidance when the issue is unknown', async () => {
  const { graph } = makeGraph([[]] as never);
  const result = await recordInsightTool({ jiraKey: 'PV2-9999', rootCause: 'x' }, graph);
  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as { found: boolean; message: string };
  assert.equal(structured.found, false);
  assert.match(structured.message, /run get_context/);
});
