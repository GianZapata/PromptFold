import type { PromptChange, RawGitChange } from '../entities/git-change.entity';

import {
  ChangeSelectionMode,
  type AnyChangeSelectionMode
} from '../entities/change-selection-mode.enum';
import {
  GitChangeStatus,
  type AnyGitChangeStatus,
  type PromptChangeStatus
} from '../entities/git-change-status.enum';
import { GitScope, type AnyGitScope } from '../entities/git-scope.enum';

export type ChangeScope = AnyGitScope;
export type ChangeStatus = AnyGitChangeStatus;
export type { PromptChange, RawGitChange };

export interface ChangesForScopeInput {
  repo: string;
  staged: RawGitChange[];
  working: RawGitChange[];
  untracked: RawGitChange[];
  commit: RawGitChange[];
  branch: RawGitChange[];
}

export const changesForScope = (
  input: ChangesForScopeInput,
  scope: AnyGitScope
) => {
  let source = input.branch;

  if (scope === GitScope.Uncommitted) {
    source = [...input.staged, ...input.working, ...input.untracked];
  } else if (scope === GitScope.Staged) {
    source = input.staged;
  } else if (scope === GitScope.Commit) {
    source = input.commit;
  }

  return source.map(change => toPromptChange(input.repo, change));
};

export const gitScopeMenu = () =>
  [
    {
      kind: 'option' as const,
      scope: GitScope.Uncommitted,
      labelKey: 'Current changes'
    },
    {
      kind: 'option' as const,
      scope: GitScope.Staged,
      labelKey: 'Staged only'
    },
    { kind: 'separator' as const, labelKey: 'Advanced' },
    {
      kind: 'option' as const,
      scope: GitScope.Commit,
      labelKey: 'A specific commit'
    },
    {
      kind: 'option' as const,
      scope: GitScope.Branch,
      labelKey: 'Compare branch'
    }
  ] as const;

export const changeBadge = (status: string) => {
  if (status === GitChangeStatus.Added) {
    return 'A';
  }

  if (status === GitChangeStatus.Deleted) {
    return 'D';
  }

  if (status === GitChangeStatus.Renamed) {
    return 'R';
  }

  if (
    status === GitChangeStatus.Modified ||
    status === GitChangeStatus.Submodule
  ) {
    return 'M';
  }

  return '';
};

export const changeStatusLabel = (status: string) => {
  if (status === GitChangeStatus.Added) {
    return 'Added';
  }

  if (status === GitChangeStatus.Deleted) {
    return 'Deleted';
  }

  if (status === GitChangeStatus.Renamed) {
    return 'Renamed';
  }

  if (status === GitChangeStatus.Submodule) {
    return 'Submodule';
  }

  return 'Modified';
};

export const reposWithoutIncludableFiles = (
  repos: Array<{ name: string; wanted: string[] }>,
  checked: ReadonlySet<string>
) =>
  repos
    .filter(repo => repo.wanted.every(filePath => !checked.has(filePath)))
    .map(repo => repo.name);

export const pathsToCheck = (changes: PromptChange[]) =>
  changes
    .filter(
      change =>
        change.status === GitChangeStatus.Added ||
        change.status === GitChangeStatus.Modified
    )
    .map(change => change.path);

export const mergeChanges = (current: PromptChange[], next: PromptChange[]) => {
  const merged = new Map<string, PromptChange>();

  for (const change of [...current, ...next]) {
    merged.set(`${change.repo}\0${change.path}`, change);
  }

  return [...merged.values()];
};

export const applyChangeSelection = (
  current: string[],
  changes: PromptChange[],
  mode: AnyChangeSelectionMode
) => {
  const next = pathsToCheck(changes);

  if (mode === ChangeSelectionMode.Replace) {
    return next;
  }

  return [...new Set([...current, ...next])];
};

export interface BaseChoicesInput {
  upstream?: string;
  branches: string[];
}

export enum BaseChoiceKind {
  Upstream = 'upstream',
  Dev = 'dev',
  Main = 'main'
}

export interface BaseChoiceOption {
  label: string;
  kind: BaseChoiceKind;
}

export const baseChoices = (input: BaseChoicesInput) =>
  [
    input.upstream
      ? { label: input.upstream, kind: BaseChoiceKind.Upstream }
      : undefined,
    input.branches.includes('dev')
      ? { label: 'dev', kind: BaseChoiceKind.Dev }
      : undefined,
    input.branches.includes('main')
      ? { label: 'main', kind: BaseChoiceKind.Main }
      : undefined
  ].filter((item): item is BaseChoiceOption => Boolean(item));

export const mapGitStatus = (
  status: number
): RawGitChange['status'] | undefined => {
  if (status === 0 || status === 5 || status === 11) {
    return GitChangeStatus.Modified;
  }

  if (status === 1 || status === 7 || status === 9) {
    return status === 7 ? GitChangeStatus.Untracked : GitChangeStatus.Added;
  }

  if (status === 2 || status === 6) {
    return GitChangeStatus.Deleted;
  }

  if (status === 3 || status === 10) {
    return GitChangeStatus.Renamed;
  }

  if (status >= 12 && status <= 18) return GitChangeStatus.Modified;

  return undefined;
};

export interface GitStatusEntry {
  path: string;
  status: number;
  originalPath?: string;
}

export interface GitStatusGroups {
  indexChanges?: GitStatusEntry[];
  workingTreeChanges?: GitStatusEntry[];
  untrackedChanges?: GitStatusEntry[];
  mergeChanges?: GitStatusEntry[];
}

const toMappedChange = (entry: GitStatusEntry): RawGitChange | undefined => {
  const status = mapGitStatus(entry.status);

  if (!status) return undefined;

  return {
    path: entry.path,
    status,
    ...(entry.originalPath ? { originalPath: entry.originalPath } : {})
  };
};

export const changesFromGitState = (groups: GitStatusGroups) => {
  const seen = new Set<string>();
  const staged: RawGitChange[] = [];
  const working: RawGitChange[] = [];
  const untracked: RawGitChange[] = [];

  const take = (change: RawGitChange | undefined, bucket: RawGitChange[]) => {
    if (!change || seen.has(change.path)) return;

    seen.add(change.path);
    bucket.push(change);
  };

  for (const entry of groups.mergeChanges ?? []) {
    const mapped = toMappedChange(entry);

    if (!mapped) continue;

    take({ ...mapped, status: GitChangeStatus.Modified }, working);
  }

  for (const entry of groups.indexChanges ?? [])
    take(toMappedChange(entry), staged);

  for (const entry of groups.workingTreeChanges ?? []) {
    const mapped = toMappedChange(entry);

    if (!mapped) continue;

    take(
      mapped,
      mapped.status === GitChangeStatus.Untracked ? untracked : working
    );
  }

  for (const entry of groups.untrackedChanges ?? []) {
    const mapped = toMappedChange(entry);

    if (!mapped) continue;

    take({ ...mapped, status: GitChangeStatus.Untracked }, untracked);
  }

  return { staged, working, untracked };
};

const toPromptChange = (repo: string, change: RawGitChange): PromptChange => {
  const isUntracked = change.status === GitChangeStatus.Untracked;
  const status: PromptChangeStatus = isUntracked
    ? GitChangeStatus.Added
    : (change.status as PromptChangeStatus);

  const path = prefix(repo, change.path);

  return {
    repo,
    path,
    status,
    from: change.originalPath ? prefix(repo, change.originalPath) : change.from,
    to: change.to,
    binary: change.binary,
    diff: change.diff
  };
};

const prefix = (repo: string, filePath: string) => {
  const relative = filePath.replace(/\\/g, '/').replace(/^\//, '');

  if (!repo || relative.startsWith(`${repo}/`) || relative === repo) {
    return relative;
  }

  return `${repo}/${relative}`;
};
