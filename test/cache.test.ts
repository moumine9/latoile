import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteCacheStore } from '../src/cache/store.js';
import { CachedIssueSource, CachedGitlabSource } from '../src/cache/cached-clients.js';
import { getContextTool } from '../src/mcp/server.js';
import type { IssueSource, GitlabSource } from '../src/collector/traversal.js';
import type { GitlabContext, NormalizedIssue } from '../src/types.js';

function issue(key: string): NormalizedIssue {
  return {
    key,
    summary: `Summary ${key}`,
    status: 'Open',
    issueType: 'Task',
    subtasks: [],
    links: [],
    mentions: [],
    documentation: [],
  } as unknown as NormalizedIssue;
}

test('SqliteCacheStore stores and retrieves within TTL', () => {
  const store = new SqliteCacheStore(':memory:');
  store.set('jira:A-1', JSON.stringify({ ok: true }));
  assert.equal(store.get('jira:A-1', 60_000), JSON.stringify({ ok: true }));
  store.close();
});

test('SqliteCacheStore expires entries past TTL', () => {
  const store = new SqliteCacheStore(':memory:');
  store.set('jira:A-1', 'x');
  assert.equal(store.get('jira:A-1', 0), undefined);
  store.close();
});

test('SqliteCacheStore upserts on repeated set', () => {
  const store = new SqliteCacheStore(':memory:');
  store.set('k', 'v1');
  store.set('k', 'v2');
  assert.equal(store.get('k', 60_000), 'v2');
  store.close();
});

test('CachedIssueSource only hits the inner source once per key', async () => {
  const store = new SqliteCacheStore(':memory:');
  let calls = 0;
  const inner: IssueSource = {
    fetchIssue: async (key: string) => {
      calls += 1;
      return issue(key);
    },
  };
  const cached = new CachedIssueSource(inner, { store, ttlMs: 60_000 });
  const first = await cached.fetchIssue('PV2-1');
  const second = await cached.fetchIssue('PV2-1');
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  store.close();
});

test('CachedIssueSource does not cache null results', async () => {
  const store = new SqliteCacheStore(':memory:');
  let calls = 0;
  const inner: IssueSource = {
    fetchIssue: async () => {
      calls += 1;
      return null;
    },
  };
  const cached = new CachedIssueSource(inner, { store, ttlMs: 60_000 });
  await cached.fetchIssue('PV2-1');
  await cached.fetchIssue('PV2-1');
  assert.equal(calls, 2);
  store.close();
});

test('CachedIssueSource refresh bypasses reads but still writes', async () => {
  const store = new SqliteCacheStore(':memory:');
  let calls = 0;
  const inner: IssueSource = {
    fetchIssue: async (key: string) => {
      calls += 1;
      return issue(key);
    },
  };
  await new CachedIssueSource(inner, { store, ttlMs: 60_000 }).fetchIssue('PV2-1');
  await new CachedIssueSource(inner, { store, ttlMs: 60_000, refresh: true }).fetchIssue('PV2-1');
  assert.equal(calls, 2);
  // The refresh run rewrote the cache, so a normal read now hits.
  await new CachedIssueSource(inner, { store, ttlMs: 60_000 }).fetchIssue('PV2-1');
  assert.equal(calls, 2);
  store.close();
});

test('CachedGitlabSource caches contexts including empty ones', async () => {
  const store = new SqliteCacheStore(':memory:');
  let calls = 0;
  const empty: GitlabContext = { mergeRequests: [] };
  const inner: GitlabSource = {
    fetchForKey: async () => {
      calls += 1;
      return empty;
    },
  };
  const cached = new CachedGitlabSource(inner, { store, ttlMs: 60_000 });
  await cached.fetchForKey('PV2-1');
  const again = await cached.fetchForKey('PV2-1');
  assert.equal(calls, 1);
  assert.deepEqual(again, empty);
  store.close();
});

test('getContextTool rejects invalid Jira keys without running the pipeline', async () => {
  let ran = false;
  const result = await getContextTool({ jiraKey: 'not a key' }, async () => {
    ran = true;
    throw new Error('unreachable');
  });
  assert.equal(result.isError, true);
  assert.equal(ran, false);
});

test('getContextTool returns the context payload as JSON text', async () => {
  const context = { entry: 'PV2-1', issues: [] };
  const result = await getContextTool({ jiraKey: 'pv2-1' }, async (key) => {
    assert.equal(key, 'PV2-1');
    return { graph: { nodes: [], edges: [] }, context } as never;
  });
  assert.equal(result.isError, undefined);
  assert.ok(result.content[0]);
  assert.deepEqual(JSON.parse(result.content[0].text), context);
});

test('getContextTool surfaces pipeline failures as tool errors', async () => {
  const result = await getContextTool({ jiraKey: 'PV2-1' }, async () => {
    throw new Error('acli exploded');
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /acli exploded/);
});
