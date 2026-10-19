import type { AnyFolderSelectionOutcome } from '../../domain/entities/folder-selection-outcome.enum';
import type { PromptChange } from '../../domain/entities/git-change.entity';
import type { ForcedRoot } from '../../domain/entities/ignore-reason.enum';
import type { AnyPathKind } from '../../domain/entities/path-kind.enum';
import type { DiscoveredRepository } from '../../domain/services/git-repos.service';
import type { SavedPromptRegistry } from '../../domain/services/saved-prompt-registry.service';

import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

import { FolderSelectionOutcome } from '../../domain/entities/folder-selection-outcome.enum';
import { IgnoreReason } from '../../domain/entities/ignore-reason.enum';
import {
  type GeneratedLedger,
  createGeneratedLedger
} from '../../domain/services/generated-ledger.service';
import { repositoryLabel } from '../../domain/services/git-repos.service';
import {
  checkboxForFolder,
  parentCheckbox,
  watcherShouldRefresh
} from '../../domain/services/parent-check.service';
import { formatByteSize } from '../../domain/services/selection-budget.service';
import {
  estimateTokensFromBytes,
  formatTokenCount
} from '../../domain/services/token-estimate.service';
import {
  filesSelectedByFolder,
  filesSelectedByFolderAsync,
  omittedFoldersFromChecks
} from '../../infrastructure/filesystem/select-files.walker';
import { createIgnoreResolver } from '../../infrastructure/ignore/ignore-resolver.service';

import { generatedFileDescription } from './generated-file-description';

export class FileTreeProvider
  implements vscode.TreeDataProvider<FileItem>, vscode.Disposable
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    FileItem | undefined | null | void
  > = new vscode.EventEmitter<FileItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    FileItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private workspaceRoot: string;
  private checkedItems: Map<string, vscode.TreeItemCheckboxState> = new Map();
  private resolver = createIgnoreResolver({ workspaceRoot: '' });
  private forcedRoots: ForcedRoot[] = [];
  private repositories: DiscoveredRepository[] = [];
  private promptChanges: PromptChange[] = [];
  private ignoredExtensions: Set<string> = new Set();
  private excludePatterns: string[] = [];
  private allowSensitive: string[] = [];
  private includeGenerated = false;
  private readonly generatedLedger: GeneratedLedger;
  private watcher: vscode.FileSystemWatcher;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    workspaceRoot: string,
    private readonly savedPrompts?: Pick<SavedPromptRegistry, 'has'>
  ) {
    this.workspaceRoot = workspaceRoot;
    this.generatedLedger = createGeneratedLedger(workspaceRoot);
    this.reloadRules();

    // Create a file system watcher
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');

    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate(uri => this.onFileSystemChanged(uri)),
      this.watcher.onDidDelete(uri => this.onFileSystemChanged(uri)),
      this.watcher.onDidChange(uri => this.onFileSystemChanged(uri)),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (
          event.affectsConfiguration('promptfold.ignoredExtensions') ||
          event.affectsConfiguration('promptfold.exclude') ||
          event.affectsConfiguration('promptfold.allowSensitive') ||
          event.affectsConfiguration('promptfold.includeGenerated') ||
          event.affectsConfiguration('promptfold.maxFileBytes')
        ) {
          this.reloadRules();
          this.refresh();
        }
      })
    );
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private onFileSystemChanged(uri: vscode.Uri): void {
    const relativePath = path.relative(this.workspaceRoot, uri.fsPath);

    if (
      !watcherShouldRefresh(relativePath, directory =>
        this.isExcluded(directory, 'directory')
      )
    ) {
      return;
    }

    if (
      uri.fsPath.endsWith('.gitignore') ||
      uri.fsPath.endsWith('.promptignore')
    ) {
      this.resolver.invalidate(uri.fsPath);
    }

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => this.refresh(), 200);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  clearChecks(): void {
    this.forcedRoots = [];
    this.reloadRules();
    this.checkedItems.clear();
    this.generatedLedger.clear();
    this.promptChanges = [];
    this.decorationEmitter.fire(undefined);
    this.refresh();
  }

  private readonly decorationEmitter = new vscode.EventEmitter<
    vscode.Uri[] | undefined
  >();
  readonly onDidChangeDecorations = this.decorationEmitter.event;

  setPromptChanges(changes: PromptChange[]): void {
    this.promptChanges = changes;
    this.decorationEmitter.fire(undefined);
    this.refresh();
  }

  clearGitChanges(): void {
    this.setPromptChanges([]);
  }

  promptChangeList(): PromptChange[] {
    return this.promptChanges.map(change => ({ ...change }));
  }

  setRepositories(repositories: DiscoveredRepository[]): void {
    this.repositories = repositories;
    this.refresh();
  }

  repositoryAt(relativePath: string): DiscoveredRepository | undefined {
    const normalized = relativePath.replace(/\\/g, '/').replace(/\/$/, '');

    return this.repositories.find(repo => repo.relativePath === normalized);
  }

  explain(relativePath: string, kind: 'file' | 'directory') {
    return this.resolver.explain(relativePath, kind);
  }

  isSkippedGenerated(relativePath: string) {
    return this.resolver.isSkippedGenerated(relativePath);
  }

  forcedRootList(): ForcedRoot[] {
    return this.forcedRoots.map(root => ({ ...root }));
  }

  addForcedRoot(root: ForcedRoot): void {
    const relativePath = root.relativePath
      .replace(/\\/g, '/')
      .replace(/\/$/, '');

    this.forcedRoots = [
      ...this.forcedRoots.filter(item => item.relativePath !== relativePath),
      { ...root, relativePath }
    ];
    this.reloadRules();
  }

  removeForcedRoot(relativePath: string): void {
    const normalized = relativePath.replace(/\\/g, '/').replace(/\/$/, '');

    this.forcedRoots = this.forcedRoots.filter(
      root => root.relativePath !== normalized
    );
    this.reloadRules();
  }

  setForcedRoots(roots: ForcedRoot[]): void {
    this.forcedRoots = roots.map(root => ({
      ...root,
      relativePath: root.relativePath.replace(/\\/g, '/').replace(/\/$/, '')
    }));
    this.reloadRules();
  }

  forcedRootFor(relativePath: string): ForcedRoot | undefined {
    const normalized = relativePath.replace(/\\/g, '/');

    return this.forcedRoots
      .filter(
        root =>
          normalized === root.relativePath ||
          normalized.startsWith(`${root.relativePath}/`)
      )
      .sort(
        (left, right) => right.relativePath.length - left.relativePath.length
      )[0];
  }

  async countIfForced(folderPath: string, root: ForcedRoot): Promise<number> {
    const preview = createIgnoreResolver({
      workspaceRoot: this.workspaceRoot,
      excludePatterns: [...this.excludePatterns],
      allowSensitive: [...this.allowSensitive],
      includeGenerated: this.includeGenerated,
      ignoredExtensions: [...this.ignoredExtensions],
      forcedRoots: [...this.forcedRoots, root],
      savedPrompts: this.savedPrompts
    });

    const result = await filesSelectedByFolderAsync(
      this.workspaceRoot,
      folderPath,
      preview.resolveBulk
    );

    return result.files.length;
  }

  async selectFolder(
    folderPath: string,
    options: { isCancelled?: () => boolean } = {}
  ): Promise<AnyFolderSelectionOutcome> {
    const snapshot = new Map(this.checkedItems);
    const generatedFiles: string[] = [];

    const result = await filesSelectedByFolderAsync(
      this.workspaceRoot,
      folderPath,
      this.resolver.resolveBulk,
      { ...options, generatedFiles }
    );

    if (result.cancelled) {
      this.checkedItems = snapshot;
      this.refresh();

      return FolderSelectionOutcome.Cancelled;
    }

    this.checkedItems.set(folderPath, vscode.TreeItemCheckboxState.Checked);
    this.generatedLedger.recordFromFolder(generatedFiles);

    for (const filePath of result.files) {
      this.checkedItems.set(filePath, vscode.TreeItemCheckboxState.Checked);
      let parent = path.dirname(filePath);

      while (parent.startsWith(folderPath)) {
        this.checkedItems.set(parent, vscode.TreeItemCheckboxState.Checked);

        if (parent === folderPath) {
          break;
        }

        parent = path.dirname(parent);
      }
    }

    let dirPath = path.dirname(folderPath);

    while (dirPath.startsWith(this.workspaceRoot)) {
      await this.updateParentState(dirPath);
      dirPath = path.dirname(dirPath);
    }

    this.refresh();

    return FolderSelectionOutcome.Applied;
  }

  async selectionStats(): Promise<{ count: number; bytes: number }> {
    const files = this.getCheckedFiles();
    let bytes = 0;

    for (const filePath of files) {
      try {
        bytes += (await fs.promises.stat(filePath)).size;
      } catch {
        continue;
      }
    }

    for (const change of this.promptChanges) {
      bytes += Buffer.byteLength(change.diff ?? '');
    }

    return { count: files.length, bytes };
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    const key = element.resourceUri.fsPath;

    if (element.hideCheckbox) {
      element.checkboxState = undefined;

      return element;
    }

    const checkboxState =
      this.checkedItems.get(key) ?? vscode.TreeItemCheckboxState.Unchecked;

    element.checkboxState = checkboxState;

    return element;
  }

  async resolveTreeItem(
    item: vscode.TreeItem,
    element: FileItem
  ): Promise<vscode.TreeItem> {
    if (element.isDirectory) return item;

    const filePath = element.resourceUri.fsPath;
    const stats = await fs.promises.stat(filePath).catch(() => undefined);

    if (!stats) return item;

    item.tooltip = [
      filePath,
      `${formatByteSize(stats.size)} · ${formatTokenCount(estimateTokensFromBytes(stats.size))}`
    ].join('\n');

    return item;
  }

  async getChildren(element?: FileItem): Promise<FileItem[]> {
    if (!this.workspaceRoot) {
      vscode.window.showInformationMessage('No workspace folder found.');

      return [];
    }

    if (!element) {
      return [
        this.withRepositoryLabel(
          '',
          new FileItem(
            path.basename(this.workspaceRoot),
            vscode.Uri.file(this.workspaceRoot),
            vscode.TreeItemCollapsibleState.Expanded,
            true,
            this.checkedItems.get(this.workspaceRoot) ??
              vscode.TreeItemCheckboxState.Unchecked,
            false,
            false
          )
        )
      ];
    }

    const dirPath = element.resourceUri.fsPath;

    return this.getFilesAndDirectories(dirPath);
  }

  private async getFilesAndDirectories(dirPath: string): Promise<FileItem[]> {
    const items: FileItem[] = [];
    const dirEntries = await fs.promises.readdir(dirPath, {
      withFileTypes: true
    });

    // Sort directories above files and alphabetically
    dirEntries.sort((a, b) => {
      const aIsDir = a.isDirectory() || a.isSymbolicLink();
      const bIsDir = b.isDirectory() || b.isSymbolicLink();

      if (aIsDir && !bIsDir) {
        return -1;
      }

      if (!aIsDir && bIsDir) {
        return 1;
      }

      return a.name.localeCompare(b.name);
    });

    for (const entry of dirEntries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(this.workspaceRoot, fullPath);
      const uri = vscode.Uri.file(fullPath);

      let isDirectory = entry.isDirectory();
      let isSymbolicLink = entry.isSymbolicLink();
      let isBrokenLink = false;

      if (isSymbolicLink) {
        try {
          const stats = await fs.promises.stat(fullPath);

          isDirectory = stats.isDirectory();
        } catch {
          // The symlink is broken
          isBrokenLink = true;
        }
      }

      // Skip broken symlinks
      if (isBrokenLink) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase().replace('.', '');
      const isIgnoredExtension = this.ignoredExtensions.has(extension);
      const kind = isDirectory ? 'directory' : 'file';
      const decision = this.explain(relativePath, kind);
      const isGitIgnored = !decision.included;
      const isSensitive =
        !decision.included && decision.reason === IgnoreReason.Sensitive;

      const hideCheckbox =
        isSensitive ||
        (isDirectory &&
          checkboxForFolder({
            included: decision.included,
            reason: decision.reason
          }) === 'hidden');

      const key = fullPath;
      const parentChecked =
        this.checkedItems.get(path.dirname(fullPath)) ===
        vscode.TreeItemCheckboxState.Checked;

      const isGenerated =
        kind === 'file' && this.resolver.isSkippedGenerated(relativePath);

      const allowed = !isGitIgnored && !isIgnoredExtension && !isGenerated;

      if (parentChecked && isGenerated) {
        this.generatedLedger.recordFromFolder([fullPath]);
      }

      let checkboxState = this.checkedItems.get(key);

      if (hideCheckbox) {
        checkboxState = undefined;
      } else if (parentChecked && allowed) {
        checkboxState = vscode.TreeItemCheckboxState.Checked;
        this.checkedItems.set(fullPath, checkboxState);
      } else if (checkboxState === undefined) {
        checkboxState = vscode.TreeItemCheckboxState.Unchecked;
      }

      const resolved = this.resolver.resolve(relativePath, kind);
      const item = new FileItem(
        entry.name,
        uri,
        isDirectory
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
        isDirectory,
        checkboxState,
        isGitIgnored || isIgnoredExtension,
        isSymbolicLink,
        hideCheckbox
      );

      if (isSensitive) {
        item.description = vscode.l10n.t('sensitive · never included');
      } else if (resolved.manual) {
        item.description = vscode.l10n.t('ignored · included manually');
      } else if (isGenerated) {
        item.description = vscode.l10n.t(
          generatedFileDescription(
            checkboxState === vscode.TreeItemCheckboxState.Checked
          )
        );
      }

      items.push(this.withRepositoryLabel(relativePath, item));
    }

    return items;
  }

  async updateCheckState(
    item: FileItem,
    state: vscode.TreeItemCheckboxState
  ): Promise<void> {
    const key = item.resourceUri.fsPath;

    this.checkedItems.set(key, state);

    if (item.isDirectory) {
      const generatedFiles: string[] = [];

      const selected = filesSelectedByFolder(
        this.workspaceRoot,
        key,
        this.resolver.resolveBulk,
        [],
        generatedFiles
      );

      if (state === vscode.TreeItemCheckboxState.Checked) {
        this.generatedLedger.recordFromFolder(generatedFiles);
      } else {
        this.generatedLedger.forgetInside(key);
      }

      for (const filePath of selected) {
        const nextState =
          state === vscode.TreeItemCheckboxState.Checked
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;

        this.checkedItems.set(filePath, nextState);
        let parent = path.dirname(filePath);

        while (parent.startsWith(key)) {
          this.checkedItems.set(parent, nextState);
          if (parent === key) {
            break;
          }

          parent = path.dirname(parent);
        }
      }

      if (state !== vscode.TreeItemCheckboxState.Checked) {
        this.clearDescendantChecks(key);
      }
    }

    // Update parent directories' states
    let dirPath = path.dirname(key);

    while (dirPath.startsWith(this.workspaceRoot)) {
      await this.updateParentState(dirPath);
      dirPath = path.dirname(dirPath);
    }

    this.refresh();
  }

  private async updateParentState(dirPath: string): Promise<void> {
    const dirEntries = await fs.promises.readdir(dirPath, {
      withFileTypes: true
    });

    const visible: SiblingState[] = [];

    for (const entry of dirEntries) {
      const siblingPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(this.workspaceRoot, siblingPath);

      const extension = path.extname(entry.name).toLowerCase().replace('.', '');
      const isIgnoredExtension = this.ignoredExtensions.has(extension);

      if (
        this.isExcluded(
          relativePath,
          entry.isDirectory() ? 'directory' : 'file'
        ) ||
        isIgnoredExtension
      ) {
        visible.push({ excluded: true, checked: false });

        continue;
      }

      const emptyFolder =
        entry.isDirectory() &&
        filesSelectedByFolder(
          this.workspaceRoot,
          siblingPath,
          this.resolver.resolveBulk
        ).length === 0;

      visible.push({
        excluded: false,
        checked:
          this.checkedItems.get(siblingPath) ===
          vscode.TreeItemCheckboxState.Checked,
        emptyFolder
      });
    }

    this.checkedItems.set(
      dirPath,
      parentCheckbox(visible) === 'checked'
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked
    );
  }

  omittedFolders(): string[] {
    const checked = [...this.checkedItems.entries()]
      .filter(
        ([filePath, state]) =>
          state === vscode.TreeItemCheckboxState.Checked &&
          fs.existsSync(filePath) &&
          fs.lstatSync(filePath).isDirectory()
      )
      .map(([filePath]) => ({ path: filePath, directory: true }));

    return omittedFoldersFromChecks(
      this.workspaceRoot,
      checked,
      this.resolver.resolve
    );
  }

  resolvePath(relativePath: string, kind: AnyPathKind) {
    return this.resolver.resolve(relativePath, kind);
  }

  resolveBulk(relativePath: string, kind: AnyPathKind) {
    return this.resolver.resolveBulk(relativePath, kind);
  }

  skippedGenerated(): string[] {
    return this.generatedLedger.skipped({
      isChecked: filePath =>
        this.checkedItems.get(filePath) ===
        vscode.TreeItemCheckboxState.Checked,
      isFolderChecked: folderPath =>
        this.checkedItems.get(folderPath) ===
        vscode.TreeItemCheckboxState.Checked,
      isStillGenerated: relativePath =>
        this.resolver.isSkippedGenerated(relativePath)
    });
  }

  getCheckedFiles(): string[] {
    return Array.from(this.checkedItems.entries())
      .filter(
        ([filePath, state]) =>
          state === vscode.TreeItemCheckboxState.Checked &&
          fs.existsSync(filePath) &&
          fs.lstatSync(filePath).isFile() &&
          this.resolver.resolve(
            path.relative(this.workspaceRoot, filePath),
            'file'
          ).included
      )
      .map(([filePath]) => filePath);
  }

  public async setCheckedFiles(
    filePaths: string[],
    options: { bulk?: boolean } = {}
  ): Promise<void> {
    const previous = options.bulk
      ? new Set(this.getCheckedFiles())
      : new Set<string>();

    if (!options.bulk) this.generatedLedger.clear();

    // Clear existing checks
    this.checkedItems.clear();

    // For each file in filePaths, set its checkboxState to Checked
    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
        continue;
      }

      const relativePath = path.relative(this.workspaceRoot, filePath);

      const decision =
        options.bulk && !previous.has(filePath)
          ? this.resolver.resolveBulk(relativePath, 'file')
          : this.resolver.resolve(relativePath, 'file');

      if (decision.reason === IgnoreReason.Generated) {
        this.generatedLedger.recordListed([filePath]);
      }

      if (!decision.included) {
        continue;
      }

      this.checkedItems.set(filePath, vscode.TreeItemCheckboxState.Checked);
    }

    // Update parent directories' checkbox states
    for (const filePath of filePaths) {
      let dirPath = path.dirname(filePath);

      while (dirPath.startsWith(this.workspaceRoot)) {
        await this.updateParentState(dirPath);
        dirPath = path.dirname(dirPath);
      }
    }

    this.refresh();
  }

  private withRepositoryLabel(relativePath: string, item: FileItem): FileItem {
    const repo = this.repositoryAt(relativePath);

    if (!repo) {
      return item;
    }

    const label = repositoryLabel(repo);

    item.description = vscode.l10n.t(label.message, ...label.args);
    item.contextValue = 'repository';

    return item;
  }

  private isExcluded(relativePath: string, kind: AnyPathKind): boolean {
    return !this.resolver.resolveBulk(relativePath, kind).included;
  }

  private clearDescendantChecks(dirPath: string): void {
    for (const key of [...this.checkedItems.keys()]) {
      if (key !== dirPath && key.startsWith(dirPath + path.sep)) {
        this.checkedItems.set(key, vscode.TreeItemCheckboxState.Unchecked);
      }
    }
  }

  private reloadRules(): void {
    const config = vscode.workspace.getConfiguration('promptfold');
    const extensionsString = config.get<string>(
      'ignoredExtensions',
      'png,jpg,jpeg,gif,svg'
    );

    this.ignoredExtensions = new Set(
      extensionsString.split(',').map(ext => ext.trim().toLowerCase())
    );

    this.excludePatterns = config.get<string[]>('exclude', []);
    this.allowSensitive = config.get<string[]>('allowSensitive', []);
    this.includeGenerated = config.get<boolean>('includeGenerated', false);
    this.resolver = createIgnoreResolver({
      workspaceRoot: this.workspaceRoot,
      excludePatterns: this.excludePatterns,
      allowSensitive: this.allowSensitive,
      includeGenerated: this.includeGenerated,
      ignoredExtensions: [...this.ignoredExtensions],
      forcedRoots: this.forcedRoots,
      savedPrompts: this.savedPrompts
    });
  }
}

interface SiblingState {
  excluded: boolean;
  checked: boolean;
  emptyFolder?: boolean;
}

export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly resourceUri: vscode.Uri,
    public collapsibleState: vscode.TreeItemCollapsibleState,
    public isDirectory: boolean,
    public checkboxState: vscode.TreeItemCheckboxState | undefined,
    public isGitIgnored: boolean,
    public isSymbolicLink: boolean = false,
    public hideCheckbox: boolean = false
  ) {
    super(label, collapsibleState);

    if (isDirectory) this.tooltip = this.resourceUri.fsPath;

    this.iconPath = new vscode.ThemeIcon(this.isDirectory ? 'folder' : 'file');
    this.checkboxState = checkboxState;
    this.contextValue = isDirectory ? 'folder' : 'file';
    if (isDirectory && isGitIgnored) {
      this.description = vscode.l10n.t('excluded');
    }

    if (this.isSymbolicLink) {
      // Optionally, you can adjust the icon or label to indicate a symlink
      this.description = this.description
        ? this.description + ' (symlink)'
        : '(symlink)';
    }
  }
}
