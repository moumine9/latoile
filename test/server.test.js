import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../src/collector/runner.js';
import { createApp } from '../src/api/server.js';

test('createRunner retries transient failures then succeeds', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    if (calls < 3) throw new Error('transient');
    return 'ok';
  };
  const run = createRunner({ exec, retries: 3, delayMs: 0 });
  const result = await run('bin', ['a']);
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('createRunner throws after exhausting retries', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    throw new Error('always fails');
  };
  const run = createRunner({ exec, retries: 1, delayMs: 0 });
  await assert.rejects(() => run('bin', []), /always fails/);
  assert.equal(calls, 2); // initial + 1 retry
});

/* --------------------------------- server -------------------------------- */

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('GET /api/graph/:key returns graph for valid key', async () => {
  const app = createApp({
    run: async (key) => ({
      graph: { entry: key, nodes: [{ id: key }], edges: [], stats: {} },
      context: { entry: key, items: [], traceability: { links: [] } },
    }),
  });
  const server = await listen(app);
  const { port } = server.address();
  try {
    const res = await fetch(`http://localhost:${port}/api/graph/JIRA-1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entry, 'JIRA-1');
    assert.equal(body.nodes[0].id, 'JIRA-1');
  } finally {
    server.close();
  }
});

test('GET /api/graph/:key?view=context returns context payload', async () => {
  const app = createApp({
    run: async (key) => ({
      graph: { nodes: [], edges: [] },
      context: { entry: key, items: [{ work_item: { id: key } }], traceability: { links: [] } },
    }),
  });
  const server = await listen(app);
  const { port } = server.address();
  try {
    const res = await fetch(`http://localhost:${port}/api/graph/JIRA-1?view=context`);
    const body = await res.json();
    assert.equal(body.items[0].work_item.id, 'JIRA-1');
  } finally {
    server.close();
  }
});

test('GET /api/graph/:key rejects an invalid key with 400', async () => {
  const app = createApp({ run: async () => ({ graph: {}, context: {} }) });
  const server = await listen(app);
  const { port } = server.address();
  try {
    const res = await fetch(`http://localhost:${port}/api/graph/not-a-key`);
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('GET /api/health returns ok', async () => {
  const app = createApp();
  const server = await listen(app);
  const { port } = server.address();
  try {
    const res = await fetch(`http://localhost:${port}/api/health`);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  } finally {
    server.close();
  }
});
