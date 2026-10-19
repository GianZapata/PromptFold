import type { AnyPathKind } from '../../domain/entities/path-kind.enum';

import * as fs from 'fs';

import * as vscode from 'vscode';

export interface ExclusionDecision {
  reason?: string;
  pattern?: string;
  sourceFile?: string;
}

export interface ExclusionForcedRoot {
  relativePath: string;
  pattern: string;
  sourceFile: string;
}

export interface ExclusionFileProvider {
  explain: (relativePath: string, kind: AnyPathKind) => ExclusionDecision;
  countIfForced: (
    folderPath: string,
    root: ExclusionForcedRoot
  ) => Promise<number>;
  addForcedRoot: (root: ExclusionForcedRoot) => void;
}

export interface ExclusionPromptSettings {
  confirm: boolean;
  remember: () => Thenable<void> | Promise<void>;
}

export const confirmExcluded = async (
  provider: ExclusionFileProvider,
  folderPath: string,
  relativePath: string,
  decision: ExclusionDecision,
  prompt: ExclusionPromptSettings = {
    confirm: true,
    remember: async () => undefined
  }
): Promise<boolean> => {
  if (
    decision.reason === 'promptignore' ||
    decision.reason === 'built-in' ||
    decision.reason === 'binary'
  ) {
    const message =
      decision.reason === 'promptignore'
        ? vscode.l10n.t(
            '{0} is excluded by .promptignore, so it stays out of the prompt.',
            relativePath
          )
        : vscode.l10n.t(
            '{0} stays out of the prompt because it is generated or binary.',
            relativePath
          );

    await vscode.window.showWarningMessage(message);

    return false;
  }

  if (decision.reason === 'sensitive') {
    await vscode.window.showWarningMessage(
      vscode.l10n.t(
        '{0} looks like a secret (credentials or keys), so it never goes into the prompt.',
        relativePath
      )
    );

    return false;
  }

  if (decision.reason === 'saved-prompt') {
    await vscode.window.showWarningMessage(
      vscode.l10n.t(
        '{0} was saved by Promptfold, so it stays out of the prompt.',
        relativePath
      )
    );

    return false;
  }

  if (
    decision.reason !== 'gitignore' &&
    decision.reason !== 'workspace-exclude'
  ) {
    await vscode.window.showWarningMessage(
      vscode.l10n.t('{0} stays out of the prompt.', relativePath)
    );

    return false;
  }

  const root: ExclusionForcedRoot = {
    relativePath: relativePath.replace(/\\/g, '/').replace(/\/$/, ''),
    pattern: decision.pattern ?? relativePath,
    sourceFile: decision.sourceFile ?? '.gitignore'
  };

  const count = fs.lstatSync(folderPath).isDirectory()
    ? await provider.countIfForced(folderPath, root)
    : 1;

  if (!prompt.confirm) {
    provider.addForcedRoot(root);

    return true;
  }

  const include = vscode.l10n.t('Include');
  const remember = vscode.l10n.t(
    'Include and do not ask again in this project'
  );

  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      '{0} is listed in {1}. Include its {2} files anyway?',
      relativePath,
      root.sourceFile,
      count
    ),
    { modal: true },
    include,
    remember
  );

  if (choice === remember) {
    await prompt.remember();
    provider.addForcedRoot(root);

    return true;
  }

  if (choice !== include) {
    return false;
  }

  provider.addForcedRoot(root);

  return true;
};
