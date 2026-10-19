import type { FileTreeProvider } from '../views/file-tree.provider';

import * as vscode from 'vscode';

import {
  formatByteSize,
  nextOutputFormat,
  outputFormatLabel,
  selectionStatus,
  shouldRefreshSummary
} from '../../domain/services/selection-budget.service';
import {
  SettingWriteTarget,
  settingWriteTarget
} from '../../domain/services/setting-write.service';
import {
  estimateTokensFromBytes,
  formatTokenCount
} from '../../domain/services/token-estimate.service';

export interface SelectionStatusBarOptions {
  fileTreeProvider: FileTreeProvider;
  treeView: vscode.TreeView<unknown>;
}

export interface SelectionStatusBarHandle {
  disposables: vscode.Disposable[];
  scheduleDescription: () => void;
}

export const createSelectionStatusBar = (
  options: SelectionStatusBarOptions
): SelectionStatusBarHandle => {
  const selectionItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );

  selectionItem.command = 'promptfold.changeOutputFormat';
  selectionItem.name = vscode.l10n.t('Promptfold selection');

  let descriptionTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleDescription = () => {
    if (descriptionTimer) {
      clearTimeout(descriptionTimer);
    }

    descriptionTimer = setTimeout(() => {
      void options.fileTreeProvider.selectionStats().then(stats => {
        const config = vscode.workspace.getConfiguration('promptfold');
        const tokens = estimateTokensFromBytes(stats.bytes);
        const changes = options.fileTreeProvider.promptChangeList();
        const status = selectionStatus({
          fileCount: stats.count,
          byteLabel: formatByteSize(stats.bytes),
          tokens,
          tokenBudget: config.get<number>('tokenBudget', 0),
          changeCount: changes.length,
          repositoryCount: new Set(changes.map(change => change.repo)).size,
          format: config.get<string>('outputFormat', 'xml')
        });

        options.treeView.description = vscode.l10n.t(
          '{0} files · {1}',
          stats.count,
          formatTokenCount(tokens)
        );

        selectionItem.text = status.text;
        selectionItem.backgroundColor = status.overBudget
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;

        selectionItem.tooltip = status.tooltip;
        selectionItem.accessibilityInformation = {
          label: status.accessibility,
          role: 'button'
        };

        selectionItem.show();
      });
    }, 200);
  };

  const changeFormatCommand = vscode.commands.registerCommand(
    'promptfold.changeOutputFormat',
    async () => {
      const current = vscode.workspace
        .getConfiguration('promptfold')
        .get<string>('outputFormat', 'xml');

      const picked = await vscode.window.showQuickPick(
        (['xml', 'markdown', 'plain'] as const).map(format => ({
          label: vscode.l10n.t(outputFormatLabel(format)),
          description:
            format === current ? vscode.l10n.t('Current') : undefined,
          format
        })),
        {
          placeHolder: vscode.l10n.t('Choose the output format')
        }
      );

      const next = nextOutputFormat(current, picked?.format);

      if (!next.changed || next.wroteClipboard) {
        return;
      }

      const config = vscode.workspace.getConfiguration('promptfold');
      const target = settingWriteTarget(config.inspect('outputFormat'));

      await config.update(
        'outputFormat',
        next.format,
        target === SettingWriteTarget.Workspace
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global
      );

      scheduleDescription();
    }
  );

  const configListener = vscode.workspace.onDidChangeConfiguration(event => {
    const section = 'promptfold.outputFormat';

    if (
      event.affectsConfiguration('promptfold.tokenBudget') ||
      (event.affectsConfiguration(section) && shouldRefreshSummary(section))
    ) {
      scheduleDescription();
    }
  });

  return {
    disposables: [selectionItem, changeFormatCommand, configListener],
    scheduleDescription
  };
};
