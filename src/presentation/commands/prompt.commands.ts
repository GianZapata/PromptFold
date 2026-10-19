import type { PromptOutputDataSource } from '../../domain/datasources/prompt-output.datasource';
import type { StateDataSource } from '../../domain/datasources/state.datasource';
import type { IgnoreDecision } from '../../domain/entities/ignore-reason.enum';
import type {
  PromptBuild,
  PromptChangeEntry
} from '../../domain/entities/prompt-payload.entity';
import type { SelectionSnapshot } from '../../domain/entities/selection-snapshot.entity';
import type { DeliverPromptUseCase } from '../../domain/use-cases/prompt/deliver-prompt.use-case';
import type { GeneratePromptUseCase } from '../../domain/use-cases/prompt/generate-prompt.use-case';
import type { SavePromptDialogOptions } from '../pickers/save-prompt.dialog';
import type {
  createDetailsSource,
  createPreviewSource
} from '../views/prompt-preview.source';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as vscode from 'vscode';

import { CopyNoticeKind } from '../../domain/entities/copy-notice-kind.enum';
import { IgnoreReason } from '../../domain/entities/ignore-reason.enum';
import { OperationKind } from '../../domain/entities/operation-kind.enum';
import { OutputFormat } from '../../domain/entities/output-format.enum';
import { PathKind } from '../../domain/entities/path-kind.enum';
import {
  formatOperationReport,
  isEmptySelection,
  type createDetailBook
} from '../../domain/services/operation-report.service';
import {
  LAST_SAVE_FOLDER_KEY,
  defaultSaveFolder,
  fileFiltersForFormat,
  resolveSaveTarget,
  revealLabelFor,
  tempPromptFilePath,
  timestampedPromptFileName
} from '../../domain/services/saved-prompt-file.service';
import {
  SKIP_TOKEN_NOTICE_KEY,
  copyNotice,
  type CopyNotice
} from '../../domain/services/selection-budget.service';
import {
  compactTokenCount,
  estimateTokens,
  estimateTokensFromBytes,
  tokenBudgetNotice
} from '../../domain/services/token-estimate.service';
import { FileOutputDataSource } from '../../infrastructure/datasources/file-output.datasource';
import {
  dedupeResolved,
  filesSelectedByFolderAsync
} from '../../infrastructure/filesystem/select-files.walker';
import {
  copyStatusMessage,
  previewStatusMessage,
  saveStatusMessage
} from '../messages/user-messages';
import { promptSaveDestination } from '../pickers/save-prompt.dialog';

export interface PromptForcedRoot {
  pattern: string;
  sourceFile: string;
}

export interface PromptExcludedDecision {
  reason?: string;
  pattern?: string;
  sourceFile?: string;
}

export interface PromptSelectionPort {
  getCheckedFiles: () => string[];
  omittedFolders: () => string[];
  promptChangeList: () => PromptChangeEntry[];
  forcedRootFor: (path: string) => PromptForcedRoot | undefined;
  explain: (relativePath: string, kind: PathKind) => IgnoreDecision;
  resolvePath: (relativePath: string, kind: PathKind) => IgnoreDecision;
  resolveBulk: (relativePath: string, kind: PathKind) => IgnoreDecision;
  skippedGenerated: () => string[];
}

export interface PromptHistoryPort {
  record: (snapshot: SelectionSnapshot) => void;
}

export type SaveDestinationPicker = (
  options?: SavePromptDialogOptions
) => Promise<vscode.Uri | undefined>;

export type FileOutputFactory = (uri: vscode.Uri) => PromptOutputDataSource;

export interface PromptCommandDeps {
  workspaceRoot: string;
  generatePrompt: GeneratePromptUseCase;
  deliverPrompt: DeliverPromptUseCase;
  clipboard: PromptOutputDataSource;
  selection: PromptSelectionPort;
  state: StateDataSource;
  registerSavedPrompt: (filePath: string) => Promise<void>;
  history: PromptHistoryPort;
  saveHistory: () => Thenable<void> | void;
  currentSnapshot: () => SelectionSnapshot;
  detailBook: ReturnType<typeof createDetailBook>;
  detailsSource: ReturnType<typeof createDetailsSource>;
  detailsEmitter: vscode.EventEmitter<vscode.Uri>;
  previewSource: ReturnType<typeof createPreviewSource>;
  previewEmitter: vscode.EventEmitter<vscode.Uri>;
  detailsUri: vscode.Uri;
  detailsChannel: vscode.OutputChannel;
  confirmExcluded: (
    filePath: string,
    relative: string,
    decision: PromptExcludedDecision
  ) => Promise<boolean>;
  saveDestinationPicker?: SaveDestinationPicker;
  createFileOutput?: FileOutputFactory;
}

export interface DeliverCollectedOptions {
  includeSystemMessage?: boolean;
  format?: OutputFormat;
  destinationUri?: vscode.Uri;
  revealOnWrite?: boolean;
  skippedGenerated?: string[];
}

const configuredFormat = (): OutputFormat =>
  vscode.workspace
    .getConfiguration('promptfold')
    .get<OutputFormat>('outputFormat', OutputFormat.Xml);

const canRevealInOS = () => vscode.env.remoteName === undefined;

const isDirectory = (folder: string) => {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
};

const suggestedSaveUri = (state: StateDataSource, format: OutputFormat) => {
  const folder = defaultSaveFolder({
    lastFolder: state.get<string>(LAST_SAVE_FOLDER_KEY),
    downloads: path.join(os.homedir(), 'Downloads'),
    home: os.homedir(),
    exists: isDirectory
  });

  return vscode.Uri.file(
    path.join(folder, timestampedPromptFileName(format, new Date()))
  );
};

const resolveCommandUris = (
  commandUri: vscode.Uri | undefined,
  selected: vscode.Uri[] | undefined
): vscode.Uri[] => {
  if (selected && selected.length > 0) {
    return selected;
  }

  if (commandUri) {
    return [commandUri];
  }

  return [];
};

const resolveReportKind = (
  stop: string,
  destinationUri?: vscode.Uri
): OperationKind => {
  if (stop === 'user-cancelled') {
    return OperationKind.Cancelled;
  }

  if (destinationUri) {
    return OperationKind.Save;
  }

  return OperationKind.Copy;
};

export const registerPromptCommands = (
  deps: PromptCommandDeps
): vscode.Disposable[] => {
  let previewVersion = 0;

  const openReport = async (report: string) => {
    deps.detailsSource.set(report);
    deps.detailsEmitter.fire(deps.detailsUri);
    const document = await vscode.workspace.openTextDocument(deps.detailsUri);

    await vscode.window.showTextDocument(document, { preview: true });
  };

  const rememberReport = (
    kind: OperationKind,
    summary: PromptBuild,
    wrote: boolean
  ) => {
    const manualIncludes = (summary.included ?? [])
      .map(file => {
        const root = deps.selection.forcedRootFor(file.name);

        return root
          ? {
              path: file.name,
              pattern: root.pattern,
              sourceFile: root.sourceFile
            }
          : undefined;
      })
      .filter((item): item is NonNullable<typeof item> => item !== undefined);

    const changeNotes = deps.selection
      .promptChangeList()
      .map(change =>
        [
          `Change: ${change.repo}`,
          change.scope ?? '',
          change.base ?? '',
          change.head ?? '',
          change.path
        ]
          .filter(Boolean)
          .join(' ')
      );

    const report = [
      formatOperationReport({
        kind,
        summary,
        wrote,
        manualIncludes
      }),
      ...changeNotes
    ].join('\n');

    deps.detailsChannel.appendLine(report);
    deps.detailsChannel.appendLine('');

    return deps.detailBook.save(report);
  };

  const confirmNotice = async (notice: CopyNotice) => {
    const message = vscode.l10n.t(notice.message, ...notice.args);

    if (notice.kind !== CopyNoticeKind.Tokens) {
      const copyFits = vscode.l10n.t('Copy what fits');
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        copyFits
      );

      return choice === copyFits;
    }

    if (deps.state.get<boolean>(SKIP_TOKEN_NOTICE_KEY) === true) return true;

    const copyAnyway = vscode.l10n.t('Copy anyway');
    const remember = vscode.l10n.t('Do not ask again in this workspace');
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      copyAnyway,
      remember
    );

    if (choice === remember) {
      await deps.state.update(SKIP_TOKEN_NOTICE_KEY, true);
    }

    return choice === copyAnyway || choice === remember;
  };

  const deliverCollected = async (
    filePaths: string[],
    output: PromptOutputDataSource,
    options: DeliverCollectedOptions = {}
  ) => {
    const includeSystemMessage = options.includeSystemMessage ?? true;
    const format = options.format;
    const destinationUri = options.destinationUri;

    if (
      isEmptySelection(filePaths, deps.selection.omittedFolders()) &&
      deps.selection.promptChangeList().length === 0
    ) {
      vscode.window.showWarningMessage(vscode.l10n.t('No files selected.'));

      return;
    }

    const limits = vscode.workspace.getConfiguration('promptfold');
    let byteCount = 0;

    for (const filePath of filePaths) {
      try {
        byteCount += (await fs.promises.stat(filePath)).size;
      } catch {
        continue;
      }
    }

    const diffBytes = deps.selection
      .promptChangeList()
      .reduce(
        (total, change) => total + Buffer.byteLength(change.diff ?? ''),
        0
      );

    const notice = copyNotice({
      fileCount: filePaths.length,
      byteCount,
      maxFiles: limits.get<number>('maxFiles', 5000),
      maxTotalBytes: limits.get<number>('maxTotalBytes', 8388608),
      tokens: estimateTokensFromBytes(byteCount + diffBytes),
      tokenBudget: limits.get<number>('tokenBudget', 0)
    });

    if (notice.over && !(await confirmNotice(notice))) return;

    let currentBuild: PromptBuild | undefined;
    const progressTitle = destinationUri
      ? vscode.l10n.t('Saving prompt')
      : vscode.l10n.t('Copying prompt');

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: progressTitle,
        cancellable: true
      },
      async (_progress, token) => {
        const deliverResult = await deps.deliverPrompt.execute(
          {
            filePaths,
            skippedGenerated: options.skippedGenerated,
            includeSystemMessage,
            format,
            isCancelled: () => token.isCancellationRequested
          },
          output
        );

        currentBuild = deliverResult.build;

        return deliverResult;
      }
    );

    if (!result.started) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('A copy is already in progress.')
      );

      return;
    }

    if (destinationUri && result.wrote) {
      await deps.registerSavedPrompt(destinationUri.fsPath);
    }

    if (
      destinationUri &&
      result.wrote &&
      options.revealOnWrite &&
      canRevealInOS()
    ) {
      await vscode.commands.executeCommand('revealFileInOS', destinationUri);
    }

    const summary = currentBuild;

    if (!summary) {
      return;
    }

    const reportKind = resolveReportKind(summary.stop, destinationUri);
    const reportId = rememberReport(reportKind, summary, result.wrote);
    const report = deps.detailBook.open(reportId) ?? '';

    if (summary.stop === 'user-cancelled') {
      const detailsLabel = vscode.l10n.t('Show details');
      const verb = destinationUri ? 'Saved' : 'Copied';

      vscode.window
        .showWarningMessage(
          `Cancelled. Collected ${summary.included.length}. ${verb} 0.`,
          detailsLabel
        )
        .then(choice => {
          if (choice === detailsLabel) {
            void openReport(report);
          }
        });

      return;
    }

    if (
      summary.included.length === 0 &&
      summary.omittedFiles.length === 0 &&
      summary.omittedFolders.length === 0
    ) {
      vscode.window.showWarningMessage(vscode.l10n.t('No files selected.'));

      return;
    }

    const detailsLabel = vscode.l10n.t('Show details');

    if (destinationUri) {
      const fileName = path.basename(destinationUri.fsPath);
      const status = saveStatusMessage({
        stop: summary.stop,
        included: summary.included.length,
        omittedFiles: summary.omittedFiles.length,
        omittedFolders: summary.omittedFolders.length,
        pending: summary.pending,
        fileName
      });

      const message = vscode.l10n.t(status.message, ...status.args);
      const openLabel = vscode.l10n.t('Open');
      const revealLabel = vscode.l10n.t(revealLabelFor(process.platform));
      const actions =
        canRevealInOS() && !options.revealOnWrite
          ? [openLabel, revealLabel, detailsLabel]
          : [openLabel, detailsLabel];

      vscode.window
        .showInformationMessage(message, ...actions)
        .then(async choice => {
          if (choice === openLabel) {
            const document =
              await vscode.workspace.openTextDocument(destinationUri);

            await vscode.window.showTextDocument(document);
          } else if (choice === revealLabel) {
            await vscode.commands.executeCommand(
              'revealFileInOS',
              destinationUri
            );
          } else if (choice === detailsLabel) {
            void openReport(report);
          }
        });

      return;
    }

    const status = copyStatusMessage({
      stop: summary.stop,
      included: summary.included.length,
      omittedFiles: summary.omittedFiles.length,
      omittedFolders: summary.omittedFolders.length,
      pending: summary.pending
    });

    const message = vscode.l10n.t(status.message, ...status.args);

    vscode.window.showInformationMessage(message, detailsLabel).then(choice => {
      if (choice === detailsLabel) {
        void openReport(report);
      }
    });
  };

  const outputFor = (destination: vscode.Uri) =>
    deps.createFileOutput
      ? deps.createFileOutput(destination)
      : new FileOutputDataSource(destination);

  const copyCollected = async (
    filePaths: string[],
    includeSystemMessage = true,
    format?: OutputFormat,
    skippedGenerated?: string[]
  ) =>
    deliverCollected(filePaths, deps.clipboard, {
      includeSystemMessage,
      format,
      skippedGenerated
    });

  return [
    vscode.commands.registerCommand('promptfold.copyFiles', async () => {
      const checkedFiles = deps.selection.getCheckedFiles();

      deps.history.record(deps.currentSnapshot());
      await deps.saveHistory();
      await copyCollected(
        checkedFiles,
        true,
        undefined,
        deps.selection.skippedGenerated()
      );
    }),

    vscode.commands.registerCommand('promptfold.copyAsXml', async () => {
      await copyCollected(
        deps.selection.getCheckedFiles(),
        true,
        OutputFormat.Xml,
        deps.selection.skippedGenerated()
      );
    }),

    vscode.commands.registerCommand('promptfold.copyAsMarkdown', async () => {
      await copyCollected(
        deps.selection.getCheckedFiles(),
        true,
        OutputFormat.Markdown,
        deps.selection.skippedGenerated()
      );
    }),

    vscode.commands.registerCommand('promptfold.copyAsPlain', async () => {
      await copyCollected(
        deps.selection.getCheckedFiles(),
        true,
        OutputFormat.Plain,
        deps.selection.skippedGenerated()
      );
    }),

    vscode.commands.registerCommand('promptfold.copyOpenFiles', async () => {
      const tabGroups: ReadonlyArray<vscode.TabGroup> =
        vscode.window.tabGroups.all;

      const files = new Set<string>();

      for (const group of tabGroups) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputText) {
            files.add(tab.input.uri.fsPath);
          }
        }
      }

      await copyCollected([...files], false);
    }),

    vscode.commands.registerCommand(
      'promptfold.copyExplorerSelection',
      async (_commandUri: vscode.Uri | undefined, selected: vscode.Uri[]) => {
        const uris = resolveCommandUris(_commandUri, selected);
        const collected: string[] = [];
        const skippedGenerated: string[] = [];

        for (const uri of uris) {
          const filePath = uri.fsPath;

          if (!fs.existsSync(filePath)) {
            continue;
          }

          if (!fs.lstatSync(filePath).isDirectory()) {
            const relative = path.relative(deps.workspaceRoot, filePath);
            const decision = deps.selection.explain(relative, PathKind.File);

            if (!decision.included) {
              const forced = await deps.confirmExcluded(
                filePath,
                relative,
                decision
              );

              if (!forced) {
                continue;
              }
            }

            collected.push(filePath);
            continue;
          }

          const relative = path.relative(deps.workspaceRoot, filePath);
          const decision = deps.selection.explain(relative, PathKind.Directory);

          if (!decision.included) {
            const forced = await deps.confirmExcluded(
              filePath,
              relative,
              decision
            );

            if (!forced) {
              continue;
            }
          }

          const result = await filesSelectedByFolderAsync(
            deps.workspaceRoot,
            filePath,
            (relative, kind) => {
              const bulk = deps.selection.resolveBulk(
                relative,
                kind as PathKind
              );

              if (bulk.reason === IgnoreReason.Generated) {
                skippedGenerated.push(relative.split(path.sep).join('/'));
              }

              return bulk;
            }
          );

          collected.push(...result.files);
        }

        await copyCollected(
          dedupeResolved(collected),
          true,
          undefined,
          skippedGenerated
        );
      }
    ),

    vscode.commands.registerCommand('promptfold.showDetails', async () => {
      const latest = deps.detailBook.latest();

      if (!latest) {
        deps.detailsChannel.show(true);

        return;
      }

      await openReport(latest);
    }),

    vscode.commands.registerCommand('promptfold.previewPrompt', async () => {
      deps.history.record(deps.currentSnapshot());
      await deps.saveHistory();

      const format = configuredFormat();
      const summary = await deps.generatePrompt.execute({
        filePaths: deps.selection.getCheckedFiles(),
        skippedGenerated: deps.selection.skippedGenerated(),
        format
      });

      const previewUri = vscode.Uri.parse(deps.previewSource.uriFor(format)).with(
        {
          query: `v=${++previewVersion}`
        }
      );

      deps.previewSource.set(previewUri.toString(), summary.output);
      deps.previewEmitter.fire(previewUri);

      const document = await vscode.workspace.openTextDocument(previewUri);

      await vscode.window.showTextDocument(document, { preview: true });

      const previewBudget = tokenBudgetNotice({
        tokens: estimateTokens(summary.output),
        budget: vscode.workspace
          .getConfiguration('promptfold')
          .get<number>('tokenBudget', 0)
      });

      if (
        previewBudget.over &&
        deps.state.get<boolean>(SKIP_TOKEN_NOTICE_KEY) !== true
      ) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'This preview is about {0} tokens, over the budget of {1}.',
            compactTokenCount(estimateTokens(summary.output)),
            previewBudget.args[2]
          )
        );
      }

      const reportId = rememberReport(OperationKind.Preview, summary, false);
      const report = deps.detailBook.open(reportId) ?? '';

      const previewNotice = previewStatusMessage({
        stop: summary.stop,
        included: summary.included.length,
        pending: summary.pending
      });

      const detailsLabel = vscode.l10n.t('Show details');

      if (summary.systemMessageFromWorkspace) {
        void vscode.window
          .showWarningMessage(
            vscode.l10n.t(
              'The system message in this prompt comes from the workspace settings, not from your user settings.'
            ),
            detailsLabel
          )
          .then(choice => {
            if (choice === detailsLabel) {
              void openReport(report);
            }
          });
      }

      vscode.window
        .showInformationMessage(
          vscode.l10n.t(previewNotice.message, ...previewNotice.args),
          detailsLabel
        )
        .then(choice => {
          if (choice === detailsLabel) {
            void openReport(report);
          }
        });
    }),

    vscode.commands.registerCommand(
      'promptfold.savePromptAs',
      async (formatOverride?: OutputFormat, destinationUri?: vscode.Uri) => {
        const checkedFiles = deps.selection.getCheckedFiles();

        if (
          isEmptySelection(checkedFiles, deps.selection.omittedFolders()) &&
          deps.selection.promptChangeList().length === 0
        ) {
          vscode.window.showWarningMessage(vscode.l10n.t('No files selected.'));

          return;
        }

        const settingFormat = formatOverride ?? configuredFormat();
        const picker = deps.saveDestinationPicker ?? promptSaveDestination;
        const chosen =
          destinationUri ??
          (await picker({
            defaultUri: suggestedSaveUri(deps.state, settingFormat),
            filters: fileFiltersForFormat(settingFormat),
            title: vscode.l10n.t('Save prompt as…')
          }));

        if (!chosen) {
          return;
        }

        const target = resolveSaveTarget(chosen.path, settingFormat);
        const destination =
          target.filePath === chosen.path
            ? chosen
            : chosen.with({ path: target.filePath });

        await deps.state.update(
          LAST_SAVE_FOLDER_KEY,
          path.dirname(destination.fsPath)
        );

        deps.history.record(deps.currentSnapshot());
        await deps.saveHistory();

        await deliverCollected(checkedFiles, outputFor(destination), {
          includeSystemMessage: true,
          format: target.format,
          destinationUri: destination,
          skippedGenerated: deps.selection.skippedGenerated()
        });
      }
    ),

    vscode.commands.registerCommand('promptfold.copyAsFile', async () => {
      const format = configuredFormat();
      const destination = vscode.Uri.file(
        tempPromptFilePath(os.tmpdir(), format, new Date())
      );

      deps.history.record(deps.currentSnapshot());
      await deps.saveHistory();

      await deliverCollected(
        deps.selection.getCheckedFiles(),
        outputFor(destination),
        {
          includeSystemMessage: true,
          format,
          destinationUri: destination,
          revealOnWrite: true,
          skippedGenerated: deps.selection.skippedGenerated()
        }
      );
    })
  ];
};
