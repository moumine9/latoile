import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJiraKeys, isJiraKey } from '../src/collector/jiraKeys.js';
import { normalizeIssue, textFromDescription, type RawJiraIssue } from '../src/collector/acli.js';
import { GlabClient, normalizeMergeRequest, normalizeCommit } from '../src/collector/glab.js';
import { GitlabHttpClient, type FetchFn } from '../src/collector/gitlab-http.js';
import { EDGE_SCHEMA } from '../src/model/graph.js';
import type { RunFn } from '../src/types.js';

test('isJiraKey validates keys', () => {
  assert.ok(isJiraKey('JIRA-123'));
  assert.ok(isJiraKey('ABC1-9'));
  assert.ok(!isJiraKey('jira-123'));
  assert.ok(!isJiraKey('JIRA'));
  assert.ok(!isJiraKey('123'));
  assert.ok(!isJiraKey(undefined));
});

test('extractJiraKeys finds distinct keys in text', () => {
  const text = 'Depends on JIRA-1 and PROJ-42. See branch feature/JIRA-1-foo. Also PROJ-42.';
  assert.deepEqual(extractJiraKeys(text).sort(), ['JIRA-1', 'PROJ-42']);
  assert.deepEqual(extractJiraKeys(''), []);
  assert.deepEqual(extractJiraKeys(null), []);
});

test('textFromDescription flattens Atlassian Document Format', () => {
  const adf = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'world' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Related to ABC-9' }] },
    ],
  };
  assert.equal(textFromDescription(adf), 'Hello world Related to ABC-9');
  assert.equal(textFromDescription('plain string'), 'plain string');
  assert.equal(textFromDescription(undefined), '');
});

test('normalizeIssue maps Jira REST shape', () => {
  const raw: RawJiraIssue = {
    key: 'JIRA-100',
    fields: {
      summary: 'Parent task',
      issuetype: { name: 'Task' },
      status: { name: 'In Progress' },
      assignee: { displayName: 'Alice' },
      parent: { key: 'EPIC-1' },
      subtasks: [{ key: 'JIRA-101' }, { key: 'JIRA-102' }],
      issuelinks: [
        { type: { outward: 'blocks' }, outwardIssue: { key: 'JIRA-200' } },
        { type: { inward: 'is blocked by' }, inwardIssue: { key: 'JIRA-50' } },
      ],
      description: 'See also JIRA-300 for context',
      comment: {
        comments: [
          { body: 'Ping JIRA-400', author: { displayName: 'Bob' }, created: '2026-07-01T10:00:00.000+0000' },
        ],
      },
    },
  };
  const issue = normalizeIssue(raw);
  assert.equal(issue.key, 'JIRA-100');
  assert.equal(issue.type, 'Task');
  assert.equal(issue.status, 'In Progress');
  assert.equal(issue.assignee, 'Alice');
  assert.equal(issue.parentKey, 'EPIC-1');
  assert.deepEqual(issue.subtasks, ['JIRA-101', 'JIRA-102']);
  assert.deepEqual(
    issue.links.map((l) => l.key).sort(),
    ['JIRA-200', 'JIRA-50']
  );
  assert.deepEqual(issue.mentions.sort(), ['JIRA-300', 'JIRA-400']);
  assert.deepEqual(issue.comments, [
    { author: 'Bob', created: '2026-07-01T10:00:00.000+0000', body: 'Ping JIRA-400' },
  ]);
});

test('normalizeIssue tolerates flat / missing fields', () => {
  const issue = normalizeIssue({ key: 'X-1', summary: 'flat', status: 'Open' });
  assert.equal(issue.key, 'X-1');
  assert.equal(issue.title, 'flat');
  assert.equal(issue.status, 'Open');
  assert.deepEqual(issue.subtasks, []);
});

test('normalizeMergeRequest and normalizeCommit', () => {
  const mr = normalizeMergeRequest(
    {
      iid: 42,
      title: 'feat: x',
      state: 'opened',
      source_branch: 'feature/JIRA-1',
      target_branch: 'main',
      web_url: 'https://gitlab/mr/42',
      author: { username: 'bob' },
    },
    'group/proj'
  );
  assert.ok(mr);
  assert.equal(mr.iid, 42);
  assert.equal(mr.project, 'group/proj');
  assert.equal(mr.sourceBranch, 'feature/JIRA-1');
  assert.equal(mr.author, 'bob');

  const commit = normalizeCommit({
    id: 'abc123def',
    short_id: 'abc123d',
    title: 'fix bug',
    author_name: 'Bob',
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.ok(commit);
  assert.equal(commit.sha, 'abc123def');
  assert.equal(commit.shortSha, 'abc123d');
  assert.equal(commit.author, 'Bob');
});

test('normalizeIssue parses customfield_10000 dev-info hint', () => {
  // json= prefix format (as seen from acli output)
  const devInfo = JSON.stringify({
    cachedValue: { summary: { repository: { count: 2 }, pullrequest: { count: 0 }, branch: { count: 1 } } },
  });
  const withData = normalizeIssue({
    key: 'PV2-1',
    fields: { summary: 'has gitlab', customfield_10000: `json=${devInfo}` },
  } as RawJiraIssue);
  assert.equal(withData.hasGitlabData, true);

  // All counts zero → false
  const emptyInfo = JSON.stringify({
    cachedValue: { summary: { repository: { count: 0 }, pullrequest: { count: 0 } } },
  });
  const noData = normalizeIssue({
    key: 'PV2-2',
    fields: { summary: 'no gitlab', customfield_10000: `json=${emptyInfo}` },
  } as RawJiraIssue);
  assert.equal(noData.hasGitlabData, false);

  // Missing field → undefined (unknown)
  const unknown = normalizeIssue({ key: 'PV2-3', fields: { summary: 'unknown' } } as RawJiraIssue);
  assert.equal(unknown.hasGitlabData, undefined);
});

test('GlabClient.mrListArgs uses glab api project-scoped search', () => {
  const noop: RunFn = async () => '[]';
  const client = new GlabClient({ run: noop, projects: ['grp/proj'] });
  const [cmd, path] = client.mrListArgs('PV2-123', 'grp/proj');
  assert.equal(cmd, 'api');
  assert.ok(path?.startsWith('projects/'), `expected projects/ path, got: ${path}`);
  assert.ok(path?.includes('search=PV2-123'), `expected search param, got: ${path}`);
  assert.ok(path?.includes('state=all'), `expected state=all, got: ${path}`);
});

test('GlabClient.groupProjectsArgs builds correct group API path', () => {
  const noop: RunFn = async () => '[]';
  const client = new GlabClient({ run: noop, groups: ['familiprix/priorx'] });
  const [cmd, path] = client.groupProjectsArgs('familiprix/priorx', 2);
  assert.equal(cmd, 'api');
  assert.ok(path?.includes('groups/'), `expected groups/ path, got: ${path}`);
  assert.ok(path?.includes('page=2'), `expected page=2, got: ${path}`);
  assert.ok(path?.includes('include_subgroups=true'), `missing include_subgroups, got: ${path}`);
});

test('GlabClient resolves projects from group and caches result', async () => {
  const calls: string[][] = [];
  const run: RunFn = async (_bin, args) => {
    calls.push(args);
    // Return two projects on first page, empty on second (stops pagination)
    const path = args[1] ?? '';
    if (path.includes('page=1') || !path.includes('page=')) {
      return JSON.stringify([
        { path_with_namespace: 'grp/alpha' },
        { path_with_namespace: 'grp/beta' },
      ]);
    }
    return '[]';
  };
  const client = new GlabClient({ run, groups: ['grp'] });
  const first = await client.resolveProjects();
  const second = await client.resolveProjects(); // should use cache
  assert.deepEqual(first, ['grp/alpha', 'grp/beta']);
  assert.equal(first, second, 'expected same cached array reference');
  // groupProjectsArgs was called only once (first resolution)
  const groupCalls = calls.filter((a) => a[0] === 'api' && a[1]?.includes('groups/'));
  assert.equal(groupCalls.length, 1);
});

/* ------------------------- GitlabHttpClient resolution ------------------- */

type FakeProject = { path_with_namespace: string; last_activity_at?: string };

/** Builds a JSON Response, matching what apiGet expects from `fetch`. */
function jsonResponse(projects: FakeProject[]): Response {
  return new Response(JSON.stringify(projects), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('GitlabHttpClient caches a complete group resolution', async () => {
  const paths: string[] = [];
  const fetchImpl: FetchFn = async (url) => {
    paths.push(url);
    return jsonResponse([{ path_with_namespace: 'grp/alpha' }, { path_with_namespace: 'grp/beta' }]);
  };
  const client = new GitlabHttpClient({ token: 't', groups: ['grp'], fetch: fetchImpl });
  const first = await client.resolveProjects();
  const second = await client.resolveProjects(); // cached — no more fetches
  assert.deepEqual(first, ['grp/alpha', 'grp/beta']);
  assert.equal(client.lastResolutionDegraded, false);
  assert.deepEqual(second, first);
  assert.equal(paths.length, 1, 'expected the second resolveProjects to hit the cache');
});

test('GitlabHttpClient does not cache a degraded resolution and retries next call', async () => {
  let alphaFails = true; // group A fails (both attempts) on the first resolution
  const fetchImpl: FetchFn = async (url) => {
    if (url.includes('groups/A')) {
      if (alphaFails) throw new Error('Request timed out');
      return jsonResponse([{ path_with_namespace: 'A/one' }]);
    }
    return jsonResponse([{ path_with_namespace: 'B/two' }]);
  };
  const client = new GitlabHttpClient({ token: 't', groups: ['A', 'B'], fetch: fetchImpl });

  const first = await client.resolveProjects();
  assert.equal(client.lastResolutionDegraded, true, 'a failed group scan must mark resolution degraded');
  assert.deepEqual(first, ['B/two'], 'best-effort list for this call');
  assert.equal(client._cachedProjects === null, true, 'a degraded resolution must not be cached');

  // Group A recovers; the next call re-resolves instead of reusing the poisoned set.
  alphaFails = false;
  const second = await client.resolveProjects();
  assert.equal(client.lastResolutionDegraded, false);
  assert.deepEqual(second.slice().sort(), ['A/one', 'B/two']);
  const cached = client._cachedProjects;
  assert.ok(cached, 'a complete resolution must be cached');
  assert.deepEqual(cached.slice().sort(), ['A/one', 'B/two']);
});

test('GitlabHttpClient retry recovers a single transient page failure', async () => {
  let attempts = 0;
  const fetchImpl: FetchFn = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Request timed out'); // first attempt fails, retry succeeds
    return jsonResponse([{ path_with_namespace: 'grp/alpha' }]);
  };
  const client = new GitlabHttpClient({ token: 't', groups: ['grp'], fetch: fetchImpl });
  const projects = await client.resolveProjects();
  assert.deepEqual(projects, ['grp/alpha']);
  assert.equal(client.lastResolutionDegraded, false, 'a retried-then-recovered scan is complete');
  assert.deepEqual(client._cachedProjects, ['grp/alpha'], 'a complete scan is cached');
  assert.equal(attempts, 2, 'expected exactly one retry');
});

test('GitlabHttpClient does not cache a page-1-only list when page 2 fails', async () => {
  // Page 1 returns a full page (100) forcing a page-2 fetch, which fails both attempts.
  const fullPage: FakeProject[] = Array.from({ length: 100 }, (_v, i) => ({
    path_with_namespace: `grp/p${i}`,
  }));
  const fetchImpl: FetchFn = async (url) => {
    // Note: `per_page=100` also contains "page=1", so match the page cursor precisely.
    if (url.includes('&page=2')) throw new Error('Request timed out'); // page 2 (and its retry) fail
    return jsonResponse(fullPage);
  };
  const client = new GitlabHttpClient({ token: 't', groups: ['grp'], fetch: fetchImpl });
  const projects = await client.resolveProjects();
  assert.equal(projects.length, 100, 'page-1 results are returned best-effort');
  assert.equal(client.lastResolutionDegraded, true, 'an incomplete paginated scan is degraded');
  assert.equal(client._cachedProjects === null, true, 'a partial page-1-only list must not be cached as complete');
});

test('GitlabHttpClient.apiGet retries on 429 and honors Retry-After', async () => {
  const waits: number[] = [];
  let calls = 0;
  const fetchImpl: FetchFn = async () => {
    calls += 1;
    if (calls <= 2) {
      return new Response('slow down', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '2' },
      });
    }
    return jsonResponse([{ path_with_namespace: 'g/p' }]);
  };
  const client = new GitlabHttpClient({
    token: 't',
    fetch: fetchImpl,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  const result = await client.apiGet<FakeProject[]>('projects/x/merge_requests');
  assert.deepEqual(result, [{ path_with_namespace: 'g/p' }]);
  assert.equal(calls, 3, 'two 429s then success');
  assert.deepEqual(waits, [2000, 2000], 'waited the Retry-After interval before each retry');
});

test('GitlabHttpClient.apiGet gives up after maxRetries on sustained 429', async () => {
  let calls = 0;
  const fetchImpl: FetchFn = async () => {
    calls += 1;
    return new Response('slow', { status: 429, statusText: 'Too Many Requests' });
  };
  const client = new GitlabHttpClient({
    token: 't',
    maxRetries: 2,
    fetch: fetchImpl,
    sleep: async () => {
      /* immediate in tests */
    },
  });
  await assert.rejects(() => client.apiGet('projects/x'), /GitLab API 429/);
  assert.equal(calls, 3, 'initial attempt + 2 retries');
});

test('rateLimitWaitMs prefers Retry-After, falls back to exponential backoff, and caps', () => {
  const client = new GitlabHttpClient({
    token: 't',
    maxBackoffMs: 5000,
    fetch: async () => new Response(''),
  });
  assert.equal(client.rateLimitWaitMs(new Response('', { status: 429, headers: { 'retry-after': '3' } }), 0), 3000);
  assert.equal(
    client.rateLimitWaitMs(new Response('', { status: 429, headers: { 'retry-after': '999' } }), 0),
    5000,
    'capped at maxBackoffMs'
  );
  const noHeader = new Response('', { status: 429 });
  assert.equal(client.rateLimitWaitMs(noHeader, 0), 1000, 'backoff 1000 * 2^0');
  assert.equal(client.rateLimitWaitMs(noHeader, 2), 4000, 'backoff 1000 * 2^2');
});

test('apiGetWithRetry retries a non-429 error even when its body contains "429"', async () => {
  let calls = 0;
  const fetchImpl: FetchFn = async () => {
    calls += 1;
    // A 500 whose body incidentally contains "429" must NOT be read as a rate limit.
    if (calls === 1) return new Response('request id: 429abc', { status: 500, statusText: 'Server Error' });
    return jsonResponse([{ path_with_namespace: 'g/p' }]);
  };
  const client = new GitlabHttpClient({ token: 't', fetch: fetchImpl });
  const result = await client.apiGetWithRetry<FakeProject[]>('groups/x/projects');
  assert.deepEqual(result, [{ path_with_namespace: 'g/p' }]);
  assert.equal(calls, 2, 'the transient 500 must still be retried, not misclassified as 429');
});

test('apiGetWithRetry does not re-attempt a genuine exhausted 429', async () => {
  let calls = 0;
  const fetchImpl: FetchFn = async () => {
    calls += 1;
    return new Response('slow', { status: 429, statusText: 'Too Many Requests' });
  };
  const client = new GitlabHttpClient({
    token: 't',
    maxRetries: 0,
    fetch: fetchImpl,
    sleep: async () => {
      /* immediate in tests */
    },
  });
  await assert.rejects(() => client.apiGetWithRetry('groups/x/projects'), /GitLab API 429/);
  assert.equal(calls, 1, 'a real 429 is not retried again by apiGetWithRetry');
});

test('EDGE_SCHEMA covers all expected edge types', () => {
  const required = [
    'parent', 'subtask', 'sibling', 'link', 'mention',
    'has_mr', 'documented_by',
  ];
  for (const type of required) {
    assert.ok(type in EDGE_SCHEMA, `EDGE_SCHEMA missing: ${type}`);
  }
  // Branches/commits are folded into the MR node, not separate node types.
  assert.ok(!('has_branch' in EDGE_SCHEMA));
  assert.ok(!('has_commit' in EDGE_SCHEMA));
  // Spot-check domains/ranges using local vars to satisfy noUncheckedIndexedAccess
  const hasMr = EDGE_SCHEMA['has_mr'];
  const docBy = EDGE_SCHEMA['documented_by'];
  assert.ok(hasMr);
  assert.equal(hasMr.source, 'jira');
  assert.equal(hasMr.target, 'merge_request');
  assert.ok(docBy);
  assert.equal(docBy.target, 'doc');
});
