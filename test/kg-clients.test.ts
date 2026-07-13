import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeGraphIssueSource, KnowledgeGraphGitlabSource, type GraphServeTally } from '../src/sink/kg-clients.js';
import { KnowledgeGraph } from '../src/sink/knowledge-graph.js';
import { buildContextGraph } from '../src/pipeline.js';
import { getContextTool } from '../src/mcp/server.js';
import type { GraphSink } from '../src/sink/graph-sink.js';
import type { GitlabContext, NormalizedIssue, TraversalResult } from '../src/types.js';

function normalizedIssue(key: string): NormalizedIssue {
  return {
    key,
    type: 'Task',
    title: `Stored ${key}`,
    status: 'Done',
    assignee: undefined,
    parentKey: undefined,
    subtasks: [],
    links: [],
    mentions: [],
    documentation: [],
    description: '',
  };
}

/** KnowledgeGraph stub answering storedIssue/storedGitlabContext directly. */
function graphStub(entries: Record<string, { issue: NormalizedIssue; ageSeconds: number }>): KnowledgeGraph {
  const graph = new KnowledgeGraph({ query: async () => [] });
  graph.storedIssue = async (key) => entries[key];
  graph.storedGitlabContext = async (key) =>
    entries[key] ? { context: { mergeRequests: [] }, ageSeconds: entries[key].ageSeconds } : undefined;
  return graph;
}

function tally(): GraphServeTally {
  return { issues: 0, gitlabContexts: 0 };
}

test('fresh stored issues are served from the graph and marked with provenance', async () => {
  const t = tally();
  const source = new KnowledgeGraphIssueSource(
    { fetchIssue: async () => assert.fail('must not hit live') },
    { graph: graphStub({ 'PV2-1': { issue: normalizedIssue('PV2-1'), ageSeconds: 60 } }), maxAgeSeconds: 3600, tally: t }
  );
  const issue = await source.fetchIssue('PV2-1');
  assert.equal(issue?.provenance, 'knowledge_graph');
  assert.equal(issue?.title, 'Stored PV2-1');
  assert.equal(t.issues, 1);
});

test('stale or unknown issues fall through to the live source', async () => {
  const t = tally();
  let liveCalls = 0;
  const live = {
    fetchIssue: async (key: string) => {
      liveCalls += 1;
      return normalizedIssue(key);
    },
  };
  const stale = new KnowledgeGraphIssueSource(live, {
    graph: graphStub({ 'PV2-1': { issue: normalizedIssue('PV2-1'), ageSeconds: 7200 } }),
    maxAgeSeconds: 3600,
    tally: t,
  });
  const served = await stale.fetchIssue('PV2-1'); // too old
  await stale.fetchIssue('PV2-9'); // unknown
  assert.equal(served?.provenance, undefined);
  assert.equal(liveCalls, 2);
  assert.equal(t.issues, 0);
});

test('graph read errors fall through to live instead of failing the traversal', async () => {
  const graph = new KnowledgeGraph({ query: async () => [] });
  graph.storedIssue = async () => {
    throw new Error('bolt down');
  };
  const source = new KnowledgeGraphIssueSource(
    { fetchIssue: async (key) => normalizedIssue(key) },
    { graph, maxAgeSeconds: 3600, tally: tally() }
  );
  const issue = await source.fetchIssue('PV2-1');
  assert.equal(issue?.key, 'PV2-1');
});

test('fresh GitLab contexts are served from the graph', async () => {
  const t = tally();
  const glab = new KnowledgeGraphGitlabSource(
    { fetchForKey: async () => assert.fail('must not hit live') as unknown as GitlabContext },
    { graph: graphStub({ 'PV2-1': { issue: normalizedIssue('PV2-1'), ageSeconds: 10 } }), maxAgeSeconds: 3600, tally: t }
  );
  const context = await glab.fetchForKey('PV2-1');
  assert.deepEqual(context, { mergeRequests: [] });
  assert.equal(t.gitlabContexts, 1);
});

test('pipeline excludes graph-served issues from sink ingestion', async () => {
  // PV2-1 (entry) is fresh in the graph; PV2-2 (mention) must go live.
  const kg = graphStub({ 'PV2-1': { issue: { ...normalizedIssue('PV2-1'), mentions: ['PV2-2'] }, ageSeconds: 5 } });
  const liveFetched: string[] = [];
  const clients = {
    acli: {
      fetchIssue: async (key: string) => {
        liveFetched.push(key);
        return normalizedIssue(key);
      },
    },
    glab: { fetchForKey: async (): Promise<GitlabContext> => ({ mergeRequests: [] }) },
  };
  let ingested: TraversalResult | undefined;
  const sink: GraphSink = {
    ingest: async (r) => {
      ingested = r;
    },
    close: async () => {},
  };

  const result = await buildContextGraph('PV2-1', {
    clients: clients as never,
    sink,
    knowledgeGraph: kg,
    maxAgeSeconds: 3600,
    maxDepth: 1,
  });

  assert.deepEqual(liveFetched, ['PV2-2']);
  assert.equal(result.graphServedIssues, 1);
  // The graph-served entry must not be re-ingested (last_seen stays honest)…
  assert.ok(ingested);
  assert.equal(ingested.issues.has('PV2-1'), false);
  // …but the live-fetched neighbor is.
  assert.equal(ingested.issues.has('PV2-2'), true);
  // The rendered payload still contains both.
  assert.ok(result.graph.nodes.some((n) => n.id === 'PV2-1'));
  assert.ok(result.graph.nodes.some((n) => n.id === 'PV2-2'));
});

test('getContextTool reports source partial when the frontier was mixed', async () => {
  const stub = {
    graph: { entry: 'PV2-1', stats: { fetched: 2, total: 2, capped: false, maxDepthReached: false, maxDepth: 1, maxNodes: 50, nodes: 2, edges: 1 }, nodes: [], edges: [] },
    context: { entry: 'PV2-1', items: [], repositories: [], traceability: { links: [] } },
    graphServedIssues: 1,
  };
  // storedContext (tier 1) misses: stub graph returns no rows.
  const kg = new KnowledgeGraph({ query: async () => [] });
  const result = await getContextTool({ jiraKey: 'PV2-1', maxAgeSeconds: 3600 }, async () => stub, undefined, kg);
  const structured = result.structuredContent as { source: string; graphServedIssues: number };
  assert.equal(structured.source, 'partial');
  assert.equal(structured.graphServedIssues, 1);
});
