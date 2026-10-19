import type {
  DiscoveredRepository,
  PromptChange,
  RawGitChange
} from '../../domain/entities/git-change.entity';
import type {
  DiffReader,
  ListedCommitStatus
} from '../../domain/services/git-diff.service';

import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

import {
  GitDataSource,
  type GitScopeOptions
} from '../../domain/datasources/git.datasource';
import { GitChangeStatus } from '../../domain/entities/git-change-status.enum';
import {
  GitScope,
  type AnyGitScope
} from '../../domain/entities/git-scope.enum';
import {
  baseChoices,
  changesForScope,
  changesFromGitState,
  mapGitStatus
} from '../../domain/services/git-changes.service';
import {
  branchRangeBase,
  fillChangeDiff,
  listCommitChanges
} from '../../domain/services/git-diff.service';
import { binaryExtensions } from '../ignore/built-in-patterns.constant';

export interface VscodeGitUriLike {
  fsPath: string;
}

export interface VscodeGitStatusChange {
  uri: VscodeGitUriLike;
  originalUri: VscodeGitUriLike;
  renameUri?: VscodeGitUriLike;
  status: number;
}

export interface VscodeGitRefLike {
  name?: string;
}

export interface VscodeGitSubmoduleLike {
  path: string;
}

export interface VscodeGitHeadLike {
  name?: string;
  commit?: string;
}

export interface VscodeGitCommitRecord {
  hash: string;
}

export interface VscodeGitLogEntry {
  hash: string;
  message: string;
}

export interface VscodeGitLogOptions {
  maxEntries?: number;
}

export interface VscodeGitRepoState {
  HEAD?: VscodeGitHeadLike;
  indexChanges?: VscodeGitStatusChange[];
  workingTreeChanges?: VscodeGitStatusChange[];
  untrackedChanges?: VscodeGitStatusChange[];
  mergeChanges?: VscodeGitStatusChange[];
  refs?: VscodeGitRefLike[];
  submodules?: VscodeGitSubmoduleLike[];
}

export interface VscodeGitRepoLike {
  rootUri: VscodeGitUriLike;
  state: VscodeGitRepoState;
  diffWith?: (ref: string, filePath: string) => Promise<string | unknown[]>;
  diffWithHEAD?: (filePath?: string) => Promise<string | unknown[]>;
  diffIndexWithHEAD?: (filePath?: string) => Promise<string | unknown[]>;
  diffBetween?: (
    ref1: string,
    ref2: string,
    filePath?: string
  ) => Promise<string | unknown[]>;
  getMergeBase?: (ref1: string, ref2: string) => Promise<string | undefined>;
  diffBlobs?: (from: string, to: string) => Promise<string>;
  show?: (ref: string, filePath: string) => Promise<string>;
  getCommit?: (ref: string) => Promise<VscodeGitCommitRecord | undefined>;
  log?: (options?: VscodeGitLogOptions) => Promise<VscodeGitLogEntry[]>;
}

export interface VscodeGitApiLike {
  repositories: VscodeGitRepoLike[];
}

const toCommitStatus = (status: string): ListedCommitStatus => {
  if (status === GitChangeStatus.Deleted || status === 'deleted') {
    return GitChangeStatus.Deleted;
  }

  if (
    status === GitChangeStatus.Added ||
    status === 'added' ||
    status === GitChangeStatus.Untracked ||
    status === 'untracked'
  ) {
    return GitChangeStatus.Added;
  }

  return GitChangeStatus.Modified;
};

export class VscodeGitDataSource extends GitDataSource {
  private getGitApi = async (): Promise<VscodeGitApiLike | undefined> => {
    const gitExtension = vscode.extensions.getExtension('vscode.git');

    if (!gitExtension) {
      return undefined;
    }

    const exports = gitExtension.isActive
      ? gitExtension.exports
      : await gitExtension.activate();

    return (exports as { getAPI: (version: 1) => VscodeGitApiLike }).getAPI(1);
  };

  isAvailable = async (): Promise<boolean> =>
    vscode.extensions.getExtension('vscode.git') !== undefined;

  getRepositories = async (
    workspaceRoot: string,
    filterRelative?: string
  ): Promise<DiscoveredRepository[]> => {
    const api = await this.getGitApi();

    if (!api) {
      return [];
    }

    const repos = api.repositories.filter(repository => {
      const relative = path
        .relative(workspaceRoot, repository.rootUri.fsPath)
        .split(path.sep)
        .join('/');

      if (filterRelative === undefined) {
        return true;
      }

      return (
        relative === filterRelative || relative.startsWith(`${filterRelative}/`)
      );
    });

    return repos.map(repository => {
      const relative = path
        .relative(workspaceRoot, repository.rootUri.fsPath)
        .split(path.sep)
        .join('/');

      return {
        relativePath: relative,
        kind: 'repository' as const,
        branch: repository.state.HEAD?.name,
        commit: repository.state.HEAD?.commit
      };
    });
  };

  getChangesForScope = async (
    workspaceRoot: string,
    repoRelative: string,
    scope: AnyGitScope,
    options: GitScopeOptions
  ): Promise<PromptChange[]> => {
    const api = await this.getGitApi();

    if (!api) {
      return [];
    }

    const targetRoot = path.normalize(
      repoRelative ? path.join(workspaceRoot, repoRelative) : workspaceRoot
    );

    const repository = api.repositories.find(repo => {
      const fsPath = path.normalize(repo.rootUri.fsPath);

      return (
        fsPath.toLowerCase() === targetRoot.toLowerCase() ||
        path.relative(fsPath, targetRoot) === ''
      );
    });

    if (!repository) {
      return [];
    }

    return this.collectFromRepository(repository, repoRelative, scope, options);
  };

  private collectFromRepository = async (
    repository: VscodeGitRepoLike,
    repo: string,
    scope: AnyGitScope,
    options: GitScopeOptions
  ): Promise<PromptChange[]> => {
    const toRaw = (change: VscodeGitStatusChange): RawGitChange | undefined => {
      const status = mapGitStatus(change.status);

      if (!status) {
        return undefined;
      }

      const relative = path
        .relative(repository.rootUri.fsPath, change.uri.fsPath)
        .split(path.sep)
        .join('/');

      const original = path
        .relative(repository.rootUri.fsPath, change.originalUri.fsPath)
        .split(path.sep)
        .join('/');

      return {
        path: relative,
        originalPath: original !== relative ? original : undefined,
        status
      };
    };

    const toEntry = (change: VscodeGitStatusChange) => {
      const filePath = path
        .relative(repository.rootUri.fsPath, change.uri.fsPath)
        .split(path.sep)
        .join('/');

      const original = path
        .relative(repository.rootUri.fsPath, change.originalUri.fsPath)
        .split(path.sep)
        .join('/');

      return {
        path: filePath,
        originalPath: original !== filePath ? original : undefined,
        status: change.status
      };
    };

    const collected = changesFromGitState({
      indexChanges: (repository.state.indexChanges ?? []).map(toEntry),
      workingTreeChanges: (repository.state.workingTreeChanges ?? []).map(
        toEntry
      ),
      untrackedChanges: (repository.state.untrackedChanges ?? []).map(toEntry),
      mergeChanges: (repository.state.mergeChanges ?? []).map(toEntry)
    });

    const staged = collected.staged;
    const trackedWorking = collected.working;
    const untracked = collected.untracked;

    let commit: RawGitChange[] = [];
    let branch: RawGitChange[] = [];
    let base: string | undefined;
    let head = repository.state.HEAD?.name;
    let commitRef = head;

    if (scope === GitScope.Commit) {
      const history = (await repository.log?.({ maxEntries: 20 })) ?? [];
      const picked = await vscode.window.showQuickPick(
        history.map(entry => ({
          label: entry.hash.slice(0, 7),
          description: entry.message,
          hash: entry.hash
        })),
        { placeHolder: vscode.l10n.t('Choose a commit') }
      );

      if (picked && repository.diffBetween && repository.diffBlobs) {
        const listed = await listCommitChanges(
          {
            parentOf: async hash => {
              try {
                const parent = await repository.getCommit?.(`${hash}~1`);

                return parent ? `${hash}~1` : undefined;
              } catch {
                return undefined;
              }
            },
            diffBetween: async (from, to) => {
              const changes = await repository.diffBetween?.(from, to);

              return Array.isArray(changes)
                ? changes
                    .map(item => toRaw(item as VscodeGitStatusChange))
                    .filter((item): item is RawGitChange => item !== undefined)
                    .map(item => ({
                      path: item.path,
                      status: toCommitStatus(item.status)
                    }))
                : [];
            },
            diffBlobs: async (from, to) =>
              (await repository.diffBlobs?.(from, to)) ?? ''
          },
          picked.hash
        );

        commit = listed.map(item => ({
          path: item.path,
          status: item.status
        }));

        commitRef = picked.hash;
        head = picked.hash.slice(0, 7);
      }
    }

    if (scope === GitScope.Branch) {
      const forcedBase = options.forcedBase;
      const choices = baseChoices({
        branches: (repository.state.refs ?? [])
          .map(ref => ref.name ?? '')
          .filter(Boolean)
      });

      const picked = forcedBase
        ? undefined
        : await vscode.window.showQuickPick(
            [
              ...choices.map(choice => ({ label: choice.label })),
              { label: vscode.l10n.t('Type a base…') }
            ],
            { placeHolder: vscode.l10n.t('Choose a base') }
          );

      let baseName: string | undefined = forcedBase;

      if (!baseName) {
        if (picked?.label === vscode.l10n.t('Type a base…')) {
          baseName = await vscode.window.showInputBox({
            prompt: vscode.l10n.t('Base branch or commit')
          });
        } else {
          baseName = picked?.label;
        }
      }

      if (baseName && repository.diffBetween) {
        const chosenBase = baseName;
        const mergeBase = await repository.getMergeBase?.(chosenBase, 'HEAD');

        base = branchRangeBase(mergeBase, chosenBase);
        const changes = await repository.diffBetween(base, 'HEAD');

        branch = Array.isArray(changes)
          ? changes
              .map(item => toRaw(item as VscodeGitStatusChange))
              .filter((item): item is RawGitChange => item !== undefined)
          : [];
      }
    }

    const initial = changesForScope(
      {
        repo,
        staged,
        working: trackedWorking,
        untracked,
        commit,
        branch
      },
      scope
    );

    const reader: DiffReader = {
      diffWithHEAD: async filePath =>
        ((await repository.diffWithHEAD?.(filePath)) as string) ?? '',
      diffWith: async (ref, filePath) =>
        ((await repository.diffWith?.(ref, filePath)) as string) ?? '',
      diffIndexWithHEAD: async filePath =>
        ((await repository.diffIndexWithHEAD?.(filePath)) as string) ?? '',
      diffBetween: async (from, to, filePath) =>
        ((await repository.diffBetween?.(from, to, filePath)) as string) ?? '',
      getMergeBase: async (baseRef, headRef) =>
        (await repository.getMergeBase?.(baseRef, headRef)) ?? undefined,
      parentOf: async hash => {
        try {
          const parent = await repository.getCommit?.(`${hash}~1`);

          return parent ? `${hash}~1` : undefined;
        } catch {
          return undefined;
        }
      },
      show: async (ref, filePath) =>
        (await repository.show?.(ref, filePath)) ?? '',
      readFile: async filePath => {
        try {
          const uri = vscode.Uri.file(
            path.join(repository.rootUri.fsPath, filePath)
          );

          return await fs.promises.readFile(uri.fsPath, 'utf8');
        } catch {
          return '';
        }
      }
    };

    const filled: PromptChange[] = [];

    for (const change of initial) {
      const relative = change.path.startsWith(`${repo}/`)
        ? change.path.slice(repo.length + 1)
        : change.path;

      const extension = relative.split('.').pop()?.toLowerCase() ?? '';
      const loaded = await fillChangeDiff(
        reader,
        {
          path: relative,
          status: change.status,
          binary: binaryExtensions.includes(extension)
        },
        scope,
        { commit: commitRef, base }
      );

      filled.push({
        ...change,
        repo,
        scope,
        diff: loaded.diff,
        binary: loaded.binary,
        base,
        head
      });
    }

    return filled;
  };
}
