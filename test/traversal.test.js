import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traverse } from '../src/collector/traversal.js';
import { buildGraph, buildContext } from '../src/model/graph.js';

/** Builds a fake acli/glab pair backed by in-memory fixtures. */
function makeClients(issues, gitlab = {}) {
  const fetched = [];
  const acli = {
    async fetchIssue(key) {
      fetched.push(key);
      return issues[key] ? { ...issues[key], key } : null;
    },
  };
  const glab = {
    async fetchForKey(key) {
      return gitlab[key] || { mergeRequests: [] };
    },
  };
  return { acli, glab, fetched };
}

const FIXTURE = {
  'JIRA-1': {
    type: 'Task',
    title: 'Entry',
    status: 'Open',
    parentKey: 'EPIC-1',
    subtasks: ['JIRA-2'],
    links: [{ key: 'JIRA-9', type: 'blocks' }],
    mentions: ['JIRA-5'],
    documentation: [{ source: 'confluence', title: 'Design', url: 'https://c/1' }],
  },
  'EPIC-1': { type: 'Epic', title: 'Epic', subtasks: ['JIRA-1', 'JIRA-3'] },
  'JIRA-2': { type: 'Sub-task', title: 'Sub', parentKey: 'JIRA-1' },
  'JIRA-3': { type: 'Task', title: 'Sibling under epic', parentKey: 'EPIC-1' },
  'JIRA-9': { type: 'Bug', title: 'Blocker' },
  'JIRA-5': { type: 'Task', title: 'Mentioned' },
};

test('traverse visits each issue once and records typed relations', async () => {
  const { acli, glab, fetched } = makeClients(FIXTURE);
  const result = await traverse('JIRA-1', { acli, glab }, { maxDepth: 3, maxNodes: 100 });

  // No key fetched more than once.
  assert.equal(new Set(fetched).size, fetched.length);

  const rel = (from, to, relation) =>
    result.relations.some((r) => r.from === from && r.to === to && r.relation === relation);

  assert.ok(rel('JIRA-1', 'EPIC-1', 'parent'));
  assert.ok(rel('JIRA-1', 'JIRA-2', 'subtask'));
  assert.ok(rel('JIRA-1', 'JIRA-9', 'link'));
  assert.ok(rel('JIRA-1', 'JIRA-5', 'mention'));
  // Siblings derived from shared parent EPIC-1.
  assert.ok(rel('JIRA-1', 'JIRA-3', 'sibling') || rel('JIRA-3', 'JIRA-1', 'sibling'));
});

test('traverse respects maxDepth (records edge, does not fetch beyond)', async () => {
  const { acli, glab, fetched } = makeClients(FIXTURE);
  const result = await traverse('JIRA-1', { acli, glab }, { maxDepth: 0, maxNodes: 100 });

  // Only the entry point is fetched at depth 0.
  assert.deepEqual(fetched, ['JIRA-1']);
  // Neighbors still appear as unresolved placeholder nodes.
  const epic = result.issues.get('EPIC-1');
  assert.ok(epic);
  assert.equal(epic.resolved, false);
  assert.equal(result.stats.maxDepthReached, true);
});

test('traverse handles unresolved issues without aborting', async () => {
  const issues = { 'JIRA-1': { title: 'Entry', links: [{ key: 'GONE-1', type: 'relates' }] } };
  const { acli, glab } = makeClients(issues);
  const result = await traverse('JIRA-1', { acli, glab }, { maxDepth: 2 });
  assert.equal(result.issues.get('GONE-1').resolved, false);
  assert.equal(result.issues.get('JIRA-1').resolved, true);
});

test('buildGraph produces typed nodes and edges incl. GitLab', async () => {
  const gitlab = {
    'JIRA-1': {
      mergeRequests: [
        {
          iid: 42,
          project: 'grp/proj',
          title: 'feat',
          state: 'opened',
          sourceBranch: 'feature/JIRA-1',
          targetBranch: 'main',
          url: 'https://g/42',
          commits: [{ sha: 'abc123', shortSha: 'abc123', title: 'c', author: 'a', timestamp: 't' }],
        },
      ],
    },
  };
  const { acli, glab } = makeClients(FIXTURE, gitlab);
  const result = await traverse('JIRA-1', { acli, glab }, { maxDepth: 2 });
  const graph = buildGraph(result);

  const types = graph.nodes.reduce((acc, n) => {
    acc[n.type] = (acc[n.type] || 0) + 1;
    return acc;
  }, {});
  assert.ok(types.jira >= 4);
  assert.equal(types.merge_request, 1);
  assert.equal(types.branch, 1);
  assert.equal(types.commit, 1);
  assert.equal(types.doc, 1);

  const entry = graph.nodes.find((n) => n.id === 'JIRA-1');
  assert.equal(entry.isEntry, true);

  assert.ok(graph.edges.some((e) => e.type === 'has_mr'));
  assert.ok(graph.edges.some((e) => e.type === 'has_commit'));
  assert.ok(graph.edges.some((e) => e.type === 'documented_by'));
});

test('buildContext yields normalized LLM payload with traceability', async () => {
  const gitlab = {
    'JIRA-1': {
      mergeRequests: [
        { iid: 7, project: 'grp/proj', title: 't', state: 'opened', sourceBranch: 'b', targetBranch: 'main', url: 'u', commits: [{ sha: 'deadbeef', title: 'c' }] },
      ],
    },
  };
  const { acli, glab } = makeClients(FIXTURE, gitlab);
  const result = await traverse('JIRA-1', { acli, glab }, { maxDepth: 2 });
  const context = buildContext(result);

  const entry = context.items.find((i) => i.work_item.id === 'JIRA-1');
  assert.equal(entry.gitlab.merge_request.id, 7);
  assert.equal(entry.gitlab.branch.last_commit_sha, 'deadbeef');
  assert.ok(context.traceability.links.some((l) => l.jira_key === 'JIRA-1' && l.merge_request_id === 7));
  // Unresolved nodes are excluded from the context payload.
  assert.ok(context.items.every((i) => i.work_item.id));
});
