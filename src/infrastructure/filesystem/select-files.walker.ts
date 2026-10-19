import type { IgnoreDecision } from '../../domain/entities/ignore-reason.enum';
import type { AnyPathKind } from '../../domain/entities/path-kind.enum';

import * as fs from 'fs';
import * as path from 'path';

import { IgnoreReason } from '../../domain/entities/ignore-reason.enum';
import { isSameOrInside } from '../../domain/helpers/path-containment';

export interface SelectFilesAsyncOptions {
  isCancelled?: () => boolean;
  yieldEvery?: number;
  omittedFolders?: string[];
  generatedFiles?: string[];
}

export interface SelectFilesAsyncResult {
  files: string[];
  cancelled: boolean;
}

export const filesSelectedByFolder = (
  workspaceRoot: string,
  folderPath: string,
  resolve: (relativePath: string, kind: AnyPathKind) => IgnoreDecision,
  omittedFolders: string[] = [],
  generatedFiles: string[] = []
): string[] => {
  const selected: string[] = [];
  const visit = (directory: string) => {
    const relativeDirectory = path.relative(workspaceRoot, directory);

    if (
      relativeDirectory !== '' &&
      !resolve(relativeDirectory, 'directory').included
    ) {
      omittedFolders.push(relativeDirectory.split(path.sep).join('/'));

      return;
    }

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(workspaceRoot, fullPath);

      if (entry.isDirectory()) {
        visit(fullPath);

        continue;
      }

      const decision = resolve(relativePath, 'file');

      if (decision.included) {
        selected.push(fullPath);
      } else if (decision.reason === IgnoreReason.Generated) {
        generatedFiles.push(fullPath);
      }
    }
  };

  visit(folderPath);

  return selected.sort();
};

export const filesSelectedByFolderAsync = async (
  workspaceRoot: string,
  folderPath: string,
  resolve: (relativePath: string, kind: AnyPathKind) => IgnoreDecision,
  options: SelectFilesAsyncOptions = {}
): Promise<SelectFilesAsyncResult> => {
  const selected: string[] = [];
  const omittedFolders = options.omittedFolders ?? [];
  const generatedFiles = options.generatedFiles ?? [];
  const yieldEvery = options.yieldEvery ?? 64;
  let seen = 0;

  const visit = async (directory: string): Promise<boolean> => {
    if (options.isCancelled?.()) {
      return false;
    }

    const relativeDirectory = path.relative(workspaceRoot, directory);

    if (
      relativeDirectory !== '' &&
      !resolve(relativeDirectory, 'directory').included
    ) {
      omittedFolders.push(relativeDirectory.split(path.sep).join('/'));

      return true;
    }

    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true
    });

    for (const entry of entries) {
      seen += 1;

      if (seen % yieldEvery === 0) {
        await new Promise(done => setImmediate(done));

        if (options.isCancelled?.()) {
          return false;
        }
      }

      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(workspaceRoot, fullPath);

      if (entry.isDirectory()) {
        const nested = await visit(fullPath);

        if (!nested) {
          return false;
        }

        continue;
      }

      const decision = resolve(relativePath, 'file');

      if (decision.included) {
        selected.push(fullPath);
      } else if (decision.reason === IgnoreReason.Generated) {
        generatedFiles.push(fullPath);
      }
    }

    return true;
  };

  const finished = await visit(folderPath);

  if (!finished) {
    return { files: [], cancelled: true };
  }

  return { files: selected.sort(), cancelled: false };
};

export const dedupeResolved = (paths: string[]): string[] => [
  ...new Set(paths.map(filePath => path.resolve(filePath)))
];

export const selectionRoots = (
  workspaceRoot: string,
  filePaths: string[]
): string[] => {
  if (filePaths.length === 0) {
    return [];
  }

  const parents = filePaths.map(filePath =>
    path.dirname(path.resolve(filePath))
  );

  let common = parents[0];

  for (const parent of parents.slice(1)) {
    while (!isSameOrInside(common, parent)) {
      const next = path.dirname(common);

      if (next === common) {
        break;
      }

      common = next;
    }
  }

  if (!isSameOrInside(workspaceRoot, common)) {
    return [workspaceRoot];
  }

  return [common];
};

const outermostDirectories = (checkedDirectories: string[]): string[] => {
  const normalized = [
    ...new Set(checkedDirectories.map(directory => path.resolve(directory)))
  ];

  return normalized.filter(
    directory =>
      !normalized.some(
        other => other !== directory && isSameOrInside(other, directory)
      )
  );
};

export const omittedFoldersFromChecks = (
  workspaceRoot: string,
  checked: Array<{ path: string; directory: boolean }>,
  resolve: (relativePath: string, kind: AnyPathKind) => IgnoreDecision
) =>
  omittedFoldersForSelection(
    workspaceRoot,
    checked.filter(item => item.directory).map(item => item.path),
    resolve
  );

export const omittedFoldersForSelection = (
  workspaceRoot: string,
  checkedDirectories: string[],
  resolve: (relativePath: string, kind: AnyPathKind) => IgnoreDecision
): string[] => {
  const found = new Set<string>();

  for (const directory of outermostDirectories(checkedDirectories)) {
    const discovered: string[] = [];

    filesSelectedByFolder(workspaceRoot, directory, resolve, discovered);

    for (const folder of discovered) {
      found.add(folder);
    }
  }

  return [...found].sort();
};
