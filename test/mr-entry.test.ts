import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMrUrl, resolveJiraKeyFromMr } from '../src/collector/mr-entry.js';
import { getContextFromMrTool } from '../src/mcp/server.js';
import type { MrContextGraph } from '../src/pipeline.js';

test('parseMrUrl accepts canonical GitLab MR URLs including subgroups', () => {
  assert.deepEqual(parseMrUrl('https://gitlab.com/familiprix/priorx/Prescription/-/merge_requests/6606'), {
    host: 'gitlab.com',
    project: 'familiprix/priorx/Prescription',
    iid: 6606,
  });
  assert.deepEqual(parseMrUrl('https://gitlab.example.com/g/p/-/merge_requests/1/diffs')?.iid, 1);
});

test('parseMrUrl rejects non-MR URLs', () => {
  assert.equal(parseMrUrl('https://gitlab.com/g/p/-/issues/5'), null);
  assert.equal(parseMrUrl('https://gitlab.com/g/p/-/merge_requests/'), null);
  assert.equal(parseMrUrl('not a url'), null);
  assert.equal(parseMrUrl('ftp://gitlab.com/g/p/-/merge_requests/3'), null);
  assert.equal(parseMrUrl('PV2-17903'), null);
});

test('resolveJiraKeyFromMr prefers the source branch and uppercases lowercase keys', async () => {
  const resolved = await resolveJiraKeyFromMr(
    { host: 'gitlab.com', project: 'g/p', iid: 9 },
    {
      apiGet: async <T,>() =>
        ({ title: 'Fix PV2-99 regression', source_branch: 'fix/pv2-17903-quelque-chose', description: 'See PV2-1' }) as T,
    }
  );
  assert.equal(resolved.key, 'PV2-17903');
  assert.equal(resolved.foundIn, 'source_branch');
});

test('resolveJiraKeyFromMr falls back to title then description', async () => {
  const resolved = await resolveJiraKeyFromMr(
    { host: 'gitlab.com', project: 'g/p', iid: 9 },
    { apiGet: async <T,>() => ({ title: 'chore: cleanup', source_branch: 'cleanup', description: 'Relates to PV2-42' }) as T }
  );
  assert.equal(resolved.key, 'PV2-42');
  assert.equal(resolved.foundIn, 'description');
});

test('resolveJiraKeyFromMr throws a clear error when no key exists', async () => {
  await assert.rejects(
    resolveJiraKeyFromMr(
      { host: 'gitlab.com', project: 'g/p', iid: 9 },
      { apiGet: async <T,>() => ({ title: 'chore', source_branch: 'main', description: '' }) as T }
    ),
    /No Jira key found in MR !9/
  );
});

test('getContextFromMrTool returns context plus resolved_from block', async () => {
  const stub: MrContextGraph = {
    graph: { entry: 'PV2-1', stats: { fetched: 1, total: 1, capped: false, maxDepthReached: false, maxDepth: 1, maxNodes: 50, nodes: 0, edges: 0 }, nodes: [], edges: [] },
    context: { entry: 'PV2-1', items: [], repositories: [], traceability: { links: [] } },
    resolvedFrom: { key: 'PV2-1', foundIn: 'source_branch', mrTitle: 't', mrProject: 'g/p', mrIid: 3 },
  };
  const result = await getContextFromMrTool({ mrUrl: 'https://gitlab.com/g/p/-/merge_requests/3' }, async () => stub);
  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as { entry: string; resolved_from: { jira_key: string; found_in: string } };
  assert.equal(structured.entry, 'PV2-1');
  assert.equal(structured.resolved_from.jira_key, 'PV2-1');
  assert.equal(structured.resolved_from.found_in, 'source_branch');
});

test('getContextFromMrTool surfaces resolution failures as tool errors', async () => {
  const result = await getContextFromMrTool({ mrUrl: 'nope' }, async () => {
    throw new Error('Not a GitLab merge request URL: nope');
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /Not a GitLab merge request URL/);
});
