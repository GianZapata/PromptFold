import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'path';

import {
  discoverRepositories,
  repositoriesForTarget,
  repositoryLabel
} from '../src/domain/services/git-repos.service';

test('discovery on win32 matches the workspace ignoring drive letter case', () => {
  const found = discoverRepositories(
    'C:\\ws\\launcher',
    [
      { rootPath: 'c:\\ws\\launcher\\api', branch: 'main' },
      { rootPath: 'c:\\ws\\launcher', branch: 'trunk' },
      { rootPath: 'c:\\ws\\launcher-other\\web', branch: 'main' },
      { rootPath: 'D:\\ws\\launcher\\docs', branch: 'main' }
    ],
    () => true,
    path.win32
  );

  assert.deepEqual(
    found.map(repo => repo.relativePath),
    ['api', '']
  );
});

test('discovery keeps repositories and submodules, and skips an excluded worktree', () => {
  const found = discoverRepositories(
    '/ws/launcher',
    [
      {
        rootPath: '/ws/launcher/launcher/api',
        branch: 'feature/example',
        submodules: [{ path: 'vendor/pkg', commit: 'abcdef1234567890' }]
      },
      {
        rootPath: '/ws/launcher/launcher/web',
        branch: 'main'
      },
      {
        rootPath: '/ws/launcher/launcher/web/.worktrees/feature-structure-01',
        branch: 'feature-structure-01'
      }
    ],
    relative => !relative.includes('.worktrees')
  );

  assert.deepEqual(
    found.map(repo => repo.relativePath),
    ['launcher/api', 'launcher/api/vendor/pkg', 'launcher/web']
  );
  assert.equal(repositoryLabel(found[0]).message, 'git · {0}');
  assert.equal(repositoryLabel(found[0]).args[0], 'feature/example');
  assert.equal(repositoryLabel(found[1]).message, 'submodule · {0}');
  assert.equal(repositoryLabel(found[1]).args[0], 'abcdef1');
});

test('a file outside every repository does not hide the workspace repositories', () => {
  const repos = [
    { relativePath: 'api', kind: 'repository' as const, branch: 'main' },
    { relativePath: 'web', kind: 'repository' as const, branch: 'main' }
  ];

  assert.deepEqual(
    repositoriesForTarget(repos, 'readme.txt').map(repo => repo.relativePath),
    ['api', 'web']
  );
  assert.deepEqual(
    repositoriesForTarget(repos, 'api').map(repo => repo.relativePath),
    ['api']
  );
  assert.deepEqual(
    repositoriesForTarget(repos, undefined).map(repo => repo.relativePath),
    ['api', 'web']
  );
});
