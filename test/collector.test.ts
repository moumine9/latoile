import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJiraKeys, isJiraKey } from '../src/collector/jiraKeys.js';
import { normalizeIssue, textFromDescription, type RawJiraIssue } from '../src/collector/acli.js';
import { normalizeMergeRequest, normalizeCommit } from '../src/collector/glab.js';

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
