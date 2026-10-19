import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyChangeSelection,
  changeBadge,
  changesForScope,
  gitScopeMenu,
  mergeChanges,
  pathsToCheck,
  reposWithoutIncludableFiles
} from '../src/domain/services/git-changes.service';

test('git scopes keep current and staged ahead of the advanced pair', () => {
  const menu = gitScopeMenu();
  const options = menu.filter(item => item.kind === 'option');

  assert.deepEqual(
    options.map(item => item.scope),
    ['uncommitted', 'staged', 'commit', 'branch']
  );
  assert.equal(menu[2]?.kind, 'separator');
  assert.equal(menu[2]?.labelKey, 'Advanced');
});

test('a Git selection with no includable files names the repository', () => {
  assert.deepEqual(
    reposWithoutIncludableFiles(
      [
        { name: 'api', wanted: ['api/package-lock.json'] },
        { name: 'web', wanted: ['web/src/app.ts'] }
      ],
      new Set(['web/src/app.ts'])
    ),
    ['api']
  );
  assert.deepEqual(
    reposWithoutIncludableFiles([{ name: 'api', wanted: [] }], new Set()),
    ['api']
  );
});

test('adding changes merges by repository and path', () => {
  const merged = mergeChanges(
    [
      {
        repo: 'api',
        path: 'api/a.ts',
        status: 'modified',
        diff: 'old'
      }
    ],
    [
      {
        repo: 'api',
        path: 'api/a.ts',
        status: 'modified',
        diff: 'new'
      },
      { repo: 'web', path: 'web/b.ts', status: 'added', diff: 'add' }
    ]
  );

  assert.equal(merged.length, 2);
  assert.equal(merged.find(change => change.path === 'api/a.ts')?.diff, 'new');
});

test('git changes badge each status', () => {
  assert.equal(changeBadge('modified'), 'M');
  assert.equal(changeBadge('added'), 'A');
  assert.equal(changeBadge('deleted'), 'D');
  assert.equal(changeBadge('renamed'), 'R');
});

test('uncommitted changes keep deletions for the diff and check only live files', () => {
  const changes = changesForScope(
    {
      repo: 'launcher/api',
      staged: [
        { path: 'app/Foo.php', status: 'modified', diff: 'diff --git a/Foo' }
      ],
      working: [
        { path: 'app/Old.php', status: 'deleted', diff: 'diff --git a/Old' }
      ],
      untracked: [{ path: 'app/New.php', status: 'untracked' }],
      commit: [],
      branch: []
    },
    'uncommitted'
  );

  assert.deepEqual(pathsToCheck(changes), [
    'launcher/api/app/Foo.php',
    'launcher/api/app/New.php'
  ]);
  assert.equal(
    changes.find(change => change.status === 'deleted')?.path,
    'launcher/api/app/Old.php'
  );
  assert.deepEqual(
    applyChangeSelection(['launcher/api/README.md'], changes, 'add'),
    [
      'launcher/api/README.md',
      'launcher/api/app/Foo.php',
      'launcher/api/app/New.php'
    ]
  );
});
