import assert from 'node:assert/strict';
import test from 'node:test';

import { GitChangeStatus } from '../src/domain/entities/git-change-status.enum';
import {
  changesFromGitState,
  mapGitStatus
} from '../src/domain/services/git-changes.service';

const entry = (path: string, status: number) => ({ path, status });

test('mixed untracked files stay in the working tree group', () => {
  const collected = changesFromGitState({
    workingTreeChanges: [entry('notes.md', 7)]
  });

  assert.deepEqual(collected.untracked, [
    { path: 'notes.md', status: GitChangeStatus.Untracked }
  ]);
});

test('separate untracked files are read from untrackedChanges', () => {
  const collected = changesFromGitState({
    untrackedChanges: [entry('notes.md', 7)]
  });

  assert.deepEqual(collected.untracked, [
    { path: 'notes.md', status: GitChangeStatus.Untracked }
  ]);
});

test('hidden untracked files are not invented', () => {
  const collected = changesFromGitState({
    workingTreeChanges: [entry('kept.ts', 5)]
  });

  assert.deepEqual(collected.untracked, []);
  assert.deepEqual(collected.working, [
    { path: 'kept.ts', status: GitChangeStatus.Modified }
  ]);
});

test('a conflicted file is included once as modified', () => {
  const collected = changesFromGitState({
    workingTreeChanges: [entry('both.ts', 5)],
    mergeChanges: [entry('both.ts', 18)]
  });

  assert.deepEqual(collected.working, [
    { path: 'both.ts', status: GitChangeStatus.Modified }
  ]);

  assert.equal(
    collected.staged.find(change => change.path === 'both.ts'),
    undefined
  );
});

test('conflict statuses 12 through 18 map to modified', () => {
  for (const status of [12, 13, 14, 15, 16, 17, 18]) {
    assert.equal(mapGitStatus(status), GitChangeStatus.Modified);
  }
});
