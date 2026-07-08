import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { createRunner, type ExecFn } from '../src/collector/runner.js';
import { createApp } from '../src/api/server.js';
import type { ContextGraph } from '../src/pipeline.js';
import type { ContextResult, GraphResult } from '../src/types.js';

test('createRunner retries transient failures then succeeds', async () => {
  let calls = 0;
  const exec: ExecFn = async () => {
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
  const exec: ExecFn = async () => {
    calls += 1;
    throw new Error('always fails');
  };
  const run = createRunner({ exec, retries: 1, delayMs: 0 });
  await assert.rejects(() => run('bin', []), /always fails/);
  assert.equal(calls, 2); // initial + 1 retry
});

/* --------------------------------- server -------------------------------- */

async function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function portOf(server: Server): number {
  const address = server.address() as AddressInfo;
  return address.port;
}

function emptyContext(entry: string): ContextResult {
  return { entry, items: [], traceability: { links: [] } };
}

function jiraGraph(entry: string): GraphResult {
  return {
    entry,
    nodes: [
      {
        id: entry,
        type: 'jira',
        key: entry,
        resolved: true,
        isEntry: true,
        depth: 0,
        documentation: [],
      },
    ],
    edges: [],
    stats: {
      fetched: 1,
      total: 1,
      capped: false,
      maxDepthReached: false,
      maxDepth: 2,
      maxNodes: 100,
      nodes: 1,
      edges: 0,
    },
  };
}

test('GET /api/graph/:key returns graph for valid key', async () => {
  const app = createApp({
    run: async (key): Promise<ContextGraph> => ({
      graph: jiraGraph(key),
      context: emptyContext(key),
    }),
  });
  const server = await listen(app);
  const port = portOf(server);
  try {
    const res = await fetch(`http://localhost:${port}/api/graph/JIRA-1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as GraphResult;
    assert.equal(body.entry, 'JIRA-1');
    assert.equal(body.nodes[0]?.id, 'JIRA-1');
  } finally {
    server.close();
  }
});

test('GET /api/graph/:key?view=context returns context payload', async () => {
  const app = createApp({
    run: async (key): Promise<ContextGraph> => ({
      graph: jiraGraph(key),
      context: {
        entry: key,
        items: [
          {
            work_item: {
              id: key,
              type: undefined,
              title: undefined,
              status: undefined,
              assignee: undefined,
              parent_id: undefined,
            },
            gitlab: undefined,
            merge_requests: [],
            documentation: [],
          },
        ],
        traceability: { links: [] },
      },
    }),
  });
  const server = await listen(app);
  const port = portOf(server);
  try {
    const res = await fetch(`http://localhost:${port}/api/graph/JIRA-1?view=context`);
    const body = (await res.json()) as ContextResult;
    assert.equal(body.items[0]?.work_item.id, 'JIRA-1');
  } finally {
    server.close();
  }
});

test('GET /api/graph/:key rejects an invalid key with 400', async () => {
  const app = createApp({
    run: async (key): Promise<ContextGraph> => ({
      graph: jiraGraph(key),
      context: emptyContext(key),
    }),
  });
  const server = await listen(app);
  const port = portOf(server);
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
  const port = portOf(server);
  try {
    const res = await fetch(`http://localhost:${port}/api/health`);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'ok');
  } finally {
    server.close();
  }
});
