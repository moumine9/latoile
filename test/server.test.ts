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
  return { entry, items: [], repositories: [], traceability: { links: [] } };
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
            repositories: [],
            documentation: [],
          },
        ],
        repositories: [],
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

/* ------------------------------- /api/search ------------------------------ */

test('escapeJqlString neutralizes quotes and trailing backslashes', async () => {
  const { escapeJqlString } = await import('../src/api/server.js');
  assert.equal(escapeJqlString('plain text'), 'plain text');
  assert.equal(escapeJqlString('foo" OR key = "X'), 'foo\\" OR key = \\"X');
  assert.equal(escapeJqlString('trailing\\'), 'trailing\\\\');
  assert.equal(escapeJqlString('a b\nc'), 'a bc');
});

test('GET /api/search escapes the query into JQL and maps results', async () => {
  const seenArgs: string[][] = [];
  const app = createApp({
    searchRun: async (_bin, args) => {
      seenArgs.push(args);
      return JSON.stringify([
        { key: 'PV2-1', fields: { summary: 'One', issuetype: { name: 'Bug' } } },
        { fields: { summary: 'no key, dropped' } },
      ]);
    },
  });
  const server = await listen(app);
  const port = portOf(server);
  try {
    const q = 'foo" OR assignee is not EMPTY OR text ~ "';
    const res = await fetch(`http://localhost:${port}/api/search?q=${encodeURIComponent(q)}`);
    const body = (await res.json()) as Array<{ key: string; summary: string; type: string }>;
    assert.equal(body.length, 1);
    assert.deepEqual(body[0], { key: 'PV2-1', summary: 'One', type: 'Bug' });

    const jqlIdx = (seenArgs[0] ?? []).indexOf('--jql');
    const jql = seenArgs[0]?.[jqlIdx + 1] ?? '';
    // The malicious quotes must arrive escaped, never as raw string delimiters.
    assert.ok(jql.includes('\\"'));
    assert.ok(!/[^\\]" OR assignee/.test(jql));
  } finally {
    server.close();
  }
});

test('GET /api/search returns [] for an empty query without invoking acli', async () => {
  let called = false;
  const app = createApp({
    searchRun: async () => {
      called = true;
      return '[]';
    },
  });
  const server = await listen(app);
  const port = portOf(server);
  try {
    const res = await fetch(`http://localhost:${port}/api/search?q=%20`);
    const body = (await res.json()) as unknown[];
    assert.deepEqual(body, []);
    assert.equal(called, false);
  } finally {
    server.close();
  }
});

test('/api/resolve-mr resolves via the injected resolver and validates input', async () => {
  const app = createApp({
    resolveMr: async (url) => {
      assert.match(url, /merge_requests\/42/);
      return { key: 'PV2-7', foundIn: 'source_branch', mrTitle: 'T', mrProject: 'g/p', mrIid: 42 };
    },
  });
  const server = await listen(app);
  try {
    const base = `http://127.0.0.1:${portOf(server)}`;
    const ok = await fetch(`${base}/api/resolve-mr?url=${encodeURIComponent('https://gitlab.com/g/p/-/merge_requests/42')}`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { key: string; mrIid: number };
    assert.equal(body.key, 'PV2-7');
    assert.equal(body.mrIid, 42);

    const missing = await fetch(`${base}/api/resolve-mr`);
    assert.equal(missing.status, 400);
    const notMr = await fetch(`${base}/api/resolve-mr?url=${encodeURIComponent('https://gitlab.com/g/p/-/issues/1')}`);
    assert.equal(notMr.status, 400);
  } finally {
    server.close();
  }
});

test('/api/resolve-mr surfaces resolution failures as 422', async () => {
  const app = createApp({
    resolveMr: async () => {
      throw new Error('No Jira key found in MR !42');
    },
  });
  const server = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${portOf(server)}/api/resolve-mr?url=${encodeURIComponent('https://gitlab.com/g/p/-/merge_requests/42')}`);
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /No Jira key found/);
  } finally {
    server.close();
  }
});
