import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJiraKeys, isJiraKey } from '../src/collector/jiraKeys.js';
import { normalizeIssue, textFromDescription, type RawJiraIssue } from '../src/collector/acli.js';
import { GlabClient, normalizeMergeRequest, normalizeCommit } from '../src/collector/glab.js';
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
      comment: { comments: [{ body: 'Ping JIRA-400' }] },
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

test('EDGE_SCHEMA covers all expected edge types', () => {
  const required = [
    'parent', 'subtask', 'sibling', 'link', 'mention',
    'has_mr', 'has_branch', 'has_commit', 'documented_by',
  ];
  for (const type of required) {
    assert.ok(type in EDGE_SCHEMA, `EDGE_SCHEMA missing: ${type}`);
  }
  // Spot-check domains/ranges using local vars to satisfy noUncheckedIndexedAccess
  const hasMr = EDGE_SCHEMA['has_mr'];
  const hasBranch = EDGE_SCHEMA['has_branch'];
  const hasCommit = EDGE_SCHEMA['has_commit'];
  const docBy = EDGE_SCHEMA['documented_by'];
  assert.ok(hasMr);
  assert.equal(hasMr.source, 'jira');
  assert.equal(hasMr.target, 'merge_request');
  assert.ok(hasBranch);
  assert.equal(hasBranch.source, 'merge_request');
  assert.ok(hasCommit);
  assert.equal(hasCommit.source, 'merge_request');
  assert.ok(docBy);
  assert.equal(docBy.target, 'doc');
});
