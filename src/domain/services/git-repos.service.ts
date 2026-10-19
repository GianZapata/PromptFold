import type {
  DiscoveredRepository,
  GitRepositoryRecord,
  GitSubmoduleRecord
} from '../entities/git-change.entity';

import * as path from 'path';

import {
  RepositoryKind,
  type AnyRepositoryKind
} from '../entities/repository-kind.enum';
import { isSameOrInside } from '../helpers/path-containment';

export type { DiscoveredRepository, GitRepositoryRecord, GitSubmoduleRecord };

export interface RepositoryLabelTarget {
  kind: AnyRepositoryKind;
  branch?: string;
  commit?: string;
}

export const shortCommit = (commit: string) => commit.slice(0, 7);

export const repositoryLabel = (repo: RepositoryLabelTarget) => {
  const name =
    repo.branch ?? (repo.commit ? shortCommit(repo.commit) : 'detached');

  if (repo.kind === RepositoryKind.Submodule) {
    return { message: 'submodule · {0}', args: [name] };
  }

  return { message: 'git · {0}', args: [name] };
};

export const discoverRepositories = (
  workspaceRoot: string,
  records: GitRepositoryRecord[],
  included: (relativeDirectory: string) => boolean,
  flavor: path.PlatformPath = path
) => {
  const found: DiscoveredRepository[] = [];

  for (const record of records) {
    const relative = relativeToWorkspace(
      workspaceRoot,
      record.rootPath,
      flavor
    );

    if (relative === undefined) {
      continue;
    }

    if (relative !== '' && !included(relative)) {
      continue;
    }

    found.push({
      relativePath: relative,
      kind: RepositoryKind.Repository,
      branch: record.branch,
      commit: record.commit
    });

    for (const submodule of record.submodules ?? []) {
      const submodulePath = joinPosix(relative, submodule.path);

      if (!included(submodulePath)) {
        continue;
      }

      found.push({
        relativePath: submodulePath,
        kind: RepositoryKind.Submodule,
        branch: submodule.branch,
        commit: submodule.commit
      });
    }
  }

  return found;
};

export interface GitApiRepositoryHead {
  name?: string;
  commit?: string;
}

export interface GitApiSubmoduleRef {
  path: string;
}

export interface GitApiRepositoryState {
  HEAD?: GitApiRepositoryHead;
  submodules?: GitApiSubmoduleRef[];
  onDidChange: (listener: () => void) => { dispose: () => void };
}

export interface GitApiRepository {
  rootUri: { fsPath: string };
  state: GitApiRepositoryState;
}

export interface GitApiLike {
  repositories: GitApiRepository[];
  onDidOpenRepository: (listener: (repository: GitApiRepository) => void) => {
    dispose: () => void;
  };
  onDidCloseRepository: (listener: (repository: GitApiRepository) => void) => {
    dispose: () => void;
  };
}

export const trackRepositories = (
  api: GitApiLike,
  onChange: () => void
): { dispose: () => void } => {
  const watched = new Map<GitApiRepository, { dispose: () => void }>();

  const watch = (repository: GitApiRepository) => {
    if (!watched.has(repository)) {
      watched.set(repository, repository.state.onDidChange(onChange));
    }
  };

  for (const repository of api.repositories) {
    watch(repository);
  }

  const opened = api.onDidOpenRepository(repository => {
    watch(repository);
    onChange();
  });
  const closed = api.onDidCloseRepository(repository => {
    watched.get(repository)?.dispose();
    watched.delete(repository);
    onChange();
  });

  return {
    dispose: () => {
      opened.dispose();
      closed.dispose();

      for (const subscription of watched.values()) {
        subscription.dispose();
      }

      watched.clear();
    }
  };
};

export const recordsFromGitApi = (api: GitApiLike): GitRepositoryRecord[] =>
  api.repositories.map(repository => ({
    rootPath: repository.rootUri.fsPath,
    branch: repository.state.HEAD?.name,
    commit: repository.state.HEAD?.commit,
    submodules: (repository.state.submodules ?? []).map(submodule => {
      const parent = repository.rootUri.fsPath
        .replace(/\\/g, '/')
        .replace(/\/$/, '');

      const opened = api.repositories.find(
        item =>
          item.rootUri.fsPath.replace(/\\/g, '/').replace(/\/$/, '') ===
          `${parent}/${submodule.path.replace(/\\/g, '/')}`
      );

      return {
        path: submodule.path,
        branch: opened?.state.HEAD?.name,
        commit: opened?.state.HEAD?.commit
      };
    })
  }));

export const gitUnavailableMessage = () =>
  'Git is not available in this window.';

export const noRepositoriesMessage = () =>
  'No Git repositories in this workspace.';

export const noChangesToIncludeMessage = () => 'No changes to include in {0}.';

export const repositoriesForTarget = (
  repos: DiscoveredRepository[],
  wanted: string | undefined
) => {
  if (wanted === undefined) return repos;

  const rooted = repos.filter(repo => repo.relativePath === wanted);

  if (rooted.length === 0) return repos;

  return rooted;
};

const relativeToWorkspace = (
  workspaceRoot: string,
  rootPath: string,
  flavor: path.PlatformPath
) => {
  if (!isSameOrInside(workspaceRoot, rootPath, flavor)) {
    return undefined;
  }

  return flavor.relative(workspaceRoot, rootPath).split(flavor.sep).join('/');
};

const joinPosix = (parent: string, child: string) => {
  const next = child.replace(/\\/g, '/').replace(/^\//, '');

  return parent ? `${parent}/${next}` : next;
};
