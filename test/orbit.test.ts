import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OrbitClient,
  repoNameFromPath,
  codeNeighborhoodsForIssue,
  type IssueForCode,
  type OrbitRepo,
  type OrbitSource,
} from '../src/collector/orbit.js';
import type { RunFn } from '../src/types.js';

test('repoNameFromPath returns the last segment, lowercased', () => {
  assert.equal(repoNameFromPath('familiprix/priorx/Prescription'), 'prescription');
  assert.equal(repoNameFromPath('familiprix/priorx/shared/notification-manager'), 'notification-manager');
  assert.equal(repoNameFromPath('portal'), 'portal');
  assert.equal(repoNameFromPath(''), '');
});

test('OrbitClient.resolveRepo parses the manifest, keeps project_id as a string, and caches', async () => {
  const queries: string[] = [];
  const run: RunFn = async (_bin, args) => {
    queries.push(args[1] ?? '');
    return JSON.stringify([
      { project_id: '1218550793252928037', repo_path: 'D:\\repos\\Prescription', branch: 'develop2', commit_sha: 'abc123' },
    ]);
  };
  const client = new OrbitClient({ run });
  const repo = await client.resolveRepo('prescription');
  assert.deepEqual(repo, {
    projectId: '1218550793252928037', // kept as string — exceeds 2^53
    repoPath: 'D:\\repos\\Prescription',
    branch: 'develop2',
    commitSha: 'abc123',
  });
  // Query casts the big id to VARCHAR and matches the lowercased last segment.
  assert.match(queries[0] ?? '', /CAST\(project_id AS VARCHAR\)/);
  assert.match(queries[0] ?? '', /= 'prescription'/);

  const again = await client.resolveRepo('Prescription'); // cache hit (case-insensitive)
  assert.equal(again, repo);
  assert.equal(queries.length, 1, 'second resolveRepo must hit the cache');
});

test('OrbitClient.resolveRepo caches a negative result', async () => {
  let calls = 0;
  const run: RunFn = async () => {
    calls += 1;
    return '[]';
  };
  const client = new OrbitClient({ run });
  assert.equal(await client.resolveRepo('ghost'), null);
  assert.equal(await client.resolveRepo('ghost'), null);
  assert.equal(calls, 1, 'a not-indexed repo is cached too');
});

test('OrbitClient.definitionsForFiles counts distinct matched files and caps definitions', async () => {
  const queries: string[] = [];
  const run: RunFn = async (_bin, args) => {
    queries.push(args[1] ?? '');
    return JSON.stringify([
      { file: 'backend/A.cs', name: 'Foo', kind: 'Class', start_line: 3 },
      { file: 'backend/A.cs', name: 'Bar', kind: 'Method', start_line: 20 },
      { file: 'frontend/b.ts', name: 'useX', kind: 'Function', start_line: 5 },
    ]);
  };
  const client = new OrbitClient({ run });
  const res = await client.definitionsForFiles('42', ['backend/A.cs', 'frontend/b.ts'], 2);
  assert.equal(res.filesMatched, 2, 'two distinct files matched');
  assert.equal(res.definitions.length, 2, 'capped at maxDefinitions');
  // Numeric project_id embedded as a literal; file list single-quoted.
  assert.match(queries[0] ?? '', /project_id = 42 /);
  assert.match(queries[0] ?? '', /IN \('backend\/A\.cs', 'frontend\/b\.ts'\)/);
});

test('OrbitClient.definitionsForFiles escapes quotes in paths and guards a bad project id', async () => {
  const queries: string[] = [];
  const run: RunFn = async (_bin, args) => {
    queries.push(args[1] ?? '');
    return '[]';
  };
  const client = new OrbitClient({ run });
  await client.definitionsForFiles('7', ["weird'name.ts"], 40);
  assert.match(queries[0] ?? '', /'weird''name\.ts'/, "single quotes doubled for SQL safety");

  const bad = await client.definitionsForFiles('not-a-number', ['a.ts'], 40);
  assert.deepEqual(bad, { filesMatched: 0, definitions: [] });
  assert.equal(queries.length, 1, 'a non-numeric project id never runs a query');
});

/* ------------------------- codeNeighborhoodsForIssue ---------------------- */

/** Stub OrbitSource: 'prescription' is indexed, everything else is not. */
function stubOrbit(): OrbitSource {
  const prescription: OrbitRepo = {
    projectId: '99',
    repoPath: 'D:\\repos\\Prescription',
    branch: 'develop2',
    commitSha: 'deadbeef',
  };
  return {
    async resolveRepo(name) {
      return name === 'prescription' ? prescription : null;
    },
    async definitionsForFiles(_projectId, files) {
      return { filesMatched: files.length, definitions: files.map((f) => ({ name: 'X', kind: 'Class', file: f, start_line: 1 })) };
    },
  };
}

test('codeNeighborhoodsForIssue distinguishes indexed vs not-indexed repos', async () => {
  const issue: IssueForCode = {
    key: 'PV2-1',
    mergeRequests: [
      { project: 'familiprix/priorx/Prescription', changedFiles: ['backend/A.cs', 'frontend/b.ts'] },
      { project: 'familiprix/priorx/ghost', changedFiles: ['x.ts'] },
    ],
  };
  const code = await codeNeighborhoodsForIssue(issue, stubOrbit(), 40);
  assert.ok(code);
  const byRepo = Object.fromEntries(code.map((c) => [c.repository, c]));

  const pres = byRepo['familiprix/priorx/Prescription'];
  assert.ok(pres);
  assert.equal(pres.indexed, true);
  assert.equal(pres.branch, 'develop2');
  assert.equal(pres.commit_sha, 'deadbeef');
  assert.equal(pres.files_changed, 2);
  assert.equal(pres.files_matched, 2);
  assert.equal(pres.definitions.length, 2);

  const ghost = byRepo['familiprix/priorx/ghost'];
  assert.ok(ghost);
  assert.equal(ghost.indexed, false);
  assert.equal(ghost.files_changed, 1);
  assert.equal(ghost.files_matched, 0);
  assert.deepEqual(ghost.definitions, []);
});

test('codeNeighborhoodsForIssue returns undefined when there are no changed files', async () => {
  const issue: IssueForCode = {
    key: 'PV2-2',
    mergeRequests: [{ project: 'familiprix/priorx/Prescription', changedFiles: [] }, { project: 'x/y' }],
  };
  const code = await codeNeighborhoodsForIssue(issue, stubOrbit(), 40);
  assert.equal(code, undefined, 'no changed files → no code block (field stays absent)');
});
