import test from 'node:test';
import assert from 'node:assert/strict';
import { describeChange } from '../src/watcher.js';

test('describeChange reports status/title/assignee changes, ignoring the rest', () => {
  const before = { key: 'PV2-1', status: 'In Progress', title: 'Old title', assignee: 'Alice' };
  const after = { key: 'PV2-1', status: 'Done', title: 'Old title', assignee: 'Bob' };
  const diff = describeChange(before, after);
  assert.match(diff ?? '', /status: In Progress → Done/);
  assert.match(diff ?? '', /assignee: Alice → Bob/);
  assert.doesNotMatch(diff ?? '', /title/);
});

test('describeChange returns undefined when nothing tracked changed', () => {
  const issue = { key: 'PV2-1', status: 'Done', title: 't', assignee: 'Alice' };
  assert.equal(describeChange(issue, { ...issue }), undefined);
});

test('describeChange returns undefined when either snapshot is missing', () => {
  assert.equal(describeChange(undefined, { key: 'PV2-1' }), undefined);
  assert.equal(describeChange({ key: 'PV2-1' }, undefined), undefined);
});
