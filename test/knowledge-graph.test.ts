import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeGraph, type CypherQueryFn } from '../src/sink/knowledge-graph.js';
import {
  findConnectionTool,
  graphStatsTool,
  knownContextTool,
  personActivityTool,
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
  ] as never);
  const result = await graph.knownContext('PV2-1');
  assert.equal(result.found, true);
  assert.equal(result.neighbors?.length, 1);
  assert.ok((result.ageSeconds ?? 0) >= 119 && (result.ageSeconds ?? 0) <= 130);
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

test('findConnectionTool validates keys before querying', async () => {
  const result = await findConnectionTool('nope', 'PV2-2');
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /valid Jira keys/);
});
