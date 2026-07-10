import test from 'node:test';
import assert from 'node:assert/strict';
import { getContextTool, getIssueTool, searchIssuesTool } from '../src/mcp/server.js';
import type { ContextGraph } from '../src/pipeline.js';
import type { NormalizedIssue } from '../src/types.js';

const CONTEXT: ContextGraph = {
  graph: { entry: 'PV2-1', stats: { fetched: 1, total: 1, capped: false, maxDepthReached: false, maxDepth: 1, maxNodes: 50, nodes: 0, edges: 0 }, nodes: [], edges: [] },
  context: { entry: 'PV2-1', items: [], traceability: { links: [] } },
};

test('getContextTool returns structuredContent matching the text payload', async () => {
  const result = await getContextTool({ jiraKey: 'pv2-1' }, async () => CONTEXT);
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent);
  assert.deepEqual(result.structuredContent, JSON.parse(result.content[0]?.text ?? '{}'));
  assert.equal((result.structuredContent as { entry: string }).entry, 'PV2-1');
});

test('getContextTool forwards pipeline logs as monotonic progress steps', async () => {
  const seen: Array<{ message: string; step: number }> = [];
  await getContextTool(
    { jiraKey: 'PV2-1' },
    async (_key, options) => {
      options.log?.('fetching PV2-1');
      options.log?.('fetching gitlab');
      return CONTEXT;
    },
    (message, step) => seen.push({ message, step })
  );
  assert.deepEqual(seen, [
    { message: 'fetching PV2-1', step: 1 },
    { message: 'fetching gitlab', step: 2 },
  ]);
});

test('searchIssuesTool wraps results as structured content', async () => {
  const result = await searchIssuesTool('ordonnance', 5, async (query, opts) => {
    assert.equal(query, 'ordonnance');
    assert.equal(opts?.limit, 5);
    return [{ key: 'PV2-9', summary: 'Une ordonnance', type: 'Bug' }];
  });
  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as { results: Array<{ key: string }> };
  assert.equal(structured.results[0]?.key, 'PV2-9');
});

test('searchIssuesTool rejects empty queries without searching', async () => {
  const result = await searchIssuesTool('   ', undefined, async () => {
    throw new Error('unreachable');
  });
  assert.equal(result.isError, true);
});

test('getIssueTool fetches a single issue through the injected source', async () => {
  const issue = { key: 'PV2-3', title: 'Une tâche', status: 'Open' } as NormalizedIssue;
  const result = await getIssueTool('pv2-3', { fetchIssue: async () => issue });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { key: string }).key, 'PV2-3');
});

test('getIssueTool surfaces missing issues as tool errors', async () => {
  const result = await getIssueTool('PV2-404', { fetchIssue: async () => null });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /not found|not accessible/);
});

test('getIssueTool rejects invalid keys without fetching', async () => {
  let fetched = false;
  const result = await getIssueTool('nope', {
    fetchIssue: async () => {
      fetched = true;
      return null;
    },
  });
  assert.equal(result.isError, true);
  assert.equal(fetched, false);
});
