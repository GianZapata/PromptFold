import fs from 'fs';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

import * as vscode from 'vscode';

import {
  activateExtension,
  waitForRepositories,
  workspaceRoot
} from './support/extension';
import { withStubs } from './support/window-stubs';

const EXTENSION_ID = 'gianzapata.promptfold';
const PROMPT_FILE_NAME = /^prompt-\d{4}-\d{2}-\d{2}-\d{4}\.(md|txt|xml)$/;

const uncommittedPaths = [
  'api/src/index.ts',
  'api/src/staged.ts',
  'web/docs/mi archivo.md',
  'web/español.md',
  'web/notas rápidas.txt'
];

const inWorkspace = (relativePath: string) =>
  vscode.Uri.file(path.join(workspaceRoot(), relativePath));

const selectUncommitted = async () => {
  await vscode.commands.executeCommand('promptfold.clearChecks');
  await withStubs({}, () =>
    vscode.commands.executeCommand(
      'promptfold.selectChanges',
      undefined,
      'uncommitted'
    )
  );
};

const copyWith = async (command: string) => {
  await vscode.env.clipboard.writeText('');
  await withStubs({}, () => vscode.commands.executeCommand(command));

  return vscode.env.clipboard.readText();
};

const withSettings = async <T>(
  values: Record<string, number>,
  work: () => PromiseLike<T>
) => {
  const target = vscode.ConfigurationTarget.Workspace;

  for (const [key, value] of Object.entries(values)) {
    await vscode.workspace
      .getConfiguration('promptfold')
      .update(key, value, target);
  }

  try {
    return await work();
  } finally {
    for (const key of Object.keys(values)) {
      await vscode.workspace
        .getConfiguration('promptfold')
        .update(key, undefined, target);
    }
  }
};

const copyWarnings = (limits: Record<string, number>) =>
  withSettings(limits, () =>
    withStubs({}, async recording => {
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('promptfold.copyFiles');

      return recording.messages.filter(
        entry =>
          entry.actions.includes('Copy what fits') ||
          entry.actions.includes('Copy anyway')
      );
    })
  );

const detailsText = async () => {
  await vscode.commands.executeCommand('promptfold.showDetails');

  return vscode.window.activeTextEditor?.document.getText() ?? '';
};

const savePromptTo = (format: string, target: vscode.Uri) =>
  withStubs({}, async recording => {
    await vscode.commands.executeCommand(
      'promptfold.savePromptAs',
      format,
      target
    );

    return recording;
  });

suite('Promptfold with two git repositories', () => {
  let outputDirectory: string;

  suiteSetup(async () => {
    await activateExtension();
    await waitForRepositories(2);

    outputDirectory = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'f2p-out-')
    );
  });

  suiteTeardown(() => {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  });

  setup(selectUncommitted);

  test('a file at the fixture root still offers the workspace repositories', async () => {
    const offered: string[] = [];

    await withStubs(
      {
        pickFor: (placeHolder, items) => {
          if (placeHolder === 'Choose repositories') {
            offered.push(...items.map(item => item.label));
          }

          return undefined;
        }
      },
      () =>
        vscode.commands.executeCommand('promptfold.selectChanges', {
          resourceUri: vscode.Uri.file(
            path.join(workspaceRoot(), 'readme.txt')
          )
        })
    );

    assert.ok(offered.includes('api'));
    assert.ok(offered.includes('web'));
  });

  test('activates the extension from the development folder', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);

    assert.equal(extension?.isActive, true);
  });

  test('selecting uncommitted changes includes staged and unstaged work with its diff', async () => {
    const xml = await copyWith('promptfold.copyAsXml');

    for (const changed of uncommittedPaths) {
      assert.ok(xml.includes(`<file name="${changed}">`), `${changed} missing`);
    }

    assert.ok(xml.includes('repo="api"'));
    assert.ok(xml.includes('repo="web"'));
    assert.ok(xml.includes('path="api/src/index.ts"'), 'index.ts diff missing');
    assert.ok(xml.includes('path="api/src/staged.ts"'), 'staged diff missing');
    assert.ok(xml.includes('path="web/español.md"'), 'staged md diff missing');
    assert.ok(xml.includes('export const version = 3;'));
    assert.equal(xml.includes('super-secret-token'), false);
    assert.equal(xml.includes('PEM PRIVATE MATERIAL'), false);
    assert.equal(xml.includes('api/.env'), false);
    assert.equal(xml.includes('server.pem'), false);
    assert.ok(xml.includes('Texto con acentuación.'));
  });

  test('copies the selection as XML', async () => {
    const xml = await copyWith('promptfold.copyAsXml');

    assert.ok(xml.startsWith('<files>'));
    assert.ok(xml.endsWith('</files>'));
    assert.ok(xml.includes('Segunda versión con acción.'));
    assert.equal(xml.includes('\r'), false);
  });

  test('copies the selection as Markdown', async () => {
    const markdown = await copyWith('promptfold.copyAsMarkdown');

    assert.ok(markdown.includes('## Git changes — web'));
    assert.ok(markdown.includes('### web/docs/mi archivo.md'));
    assert.ok(markdown.includes('Segunda versión con acción.'));
    assert.equal(markdown.includes('<files>'), false);
    assert.equal(markdown.includes('\r'), false);
  });

  test('copies the selection as plain text', async () => {
    const plain = await copyWith('promptfold.copyAsPlain');

    assert.ok(plain.includes('=== FILE web/docs/mi archivo.md ==='));
    assert.ok(plain.includes('=== DIFF web/docs/mi archivo.md (modified) ==='));
    assert.ok(plain.includes('Revisar el diseño.'));
    assert.equal(plain.includes('<files>'), false);
    assert.equal(plain.includes('\r'), false);
  });

  test('saves the prompt as Markdown when the chosen file is .md', async () => {
    const target = vscode.Uri.file(path.join(outputDirectory, 'resultado.md'));
    const recording = await savePromptTo('xml', target);
    const saved = fs.readFileSync(target.fsPath, 'utf8');

    assert.ok(saved.includes('## Git changes — web'));
    assert.ok(saved.includes('### web/docs/mi archivo.md'));
    assert.equal(saved.includes('<files>'), false);
    assert.equal(recording.saveOptions.length, 0, 'no dialog may open');
    assert.ok(
      recording.messages.some(
        entry =>
          entry.message.includes('resultado.md') &&
          entry.actions.includes('Open')
      )
    );
  });

  test('saves the prompt as plain text when the chosen file is .txt', async () => {
    const target = vscode.Uri.file(path.join(outputDirectory, 'resultado.txt'));

    await savePromptTo('xml', target);

    const saved = fs.readFileSync(target.fsPath, 'utf8');

    assert.ok(saved.includes('=== FILE web/docs/mi archivo.md ==='));
    assert.equal(saved.includes('<files>'), false);
  });

  test('offers the three filters and a default folder outside the workspace', async () => {
    const recording = await withStubs({}, async stubs => {
      await vscode.commands.executeCommand('promptfold.savePromptAs');

      return stubs;
    });

    const [options] = recording.saveOptions;

    assert.deepEqual(Object.keys(options.filters ?? {}), [
      'XML',
      'Markdown',
      'Text Files'
    ]);

    assert.equal(
      path
        .dirname(options.defaultUri?.fsPath ?? '')
        .startsWith(workspaceRoot()),
      false
    );

    assert.match(
      path.basename(options.defaultUri?.fsPath ?? ''),
      PROMPT_FILE_NAME
    );
  });

  test('copies the prompt as a file in the temp folder and reveals it', async () => {
    const recording = await withStubs({}, async stubs => {
      await vscode.commands.executeCommand('promptfold.copyAsFile');

      return stubs;
    });

    const [revealed] = recording.revealed;
    const written = fs.readFileSync(revealed.fsPath, 'utf8');

    assert.equal(
      path.dirname(revealed.fsPath),
      vscode.Uri.file(path.join(os.tmpdir(), 'promptfold')).fsPath
    );

    assert.match(path.basename(revealed.fsPath), PROMPT_FILE_NAME);
    assert.ok(written.startsWith('<files>'));
    assert.ok(written.includes('Segunda versión con acción.'));
  });

  test('keeps a prompt saved inside the workspace out of later selections', async () => {
    const target = inWorkspace('web/guardado.md');

    await savePromptTo('markdown', target);
    assert.ok(fs.existsSync(target.fsPath));

    await vscode.commands.executeCommand('promptfold.clearChecks');
    await withStubs({}, () =>
      vscode.commands.executeCommand('promptfold.selectAll')
    );

    const xml = await copyWith('promptfold.copyAsXml');

    assert.ok(xml.includes('<file name="web/src/app.ts">'));
    assert.equal(xml.includes('guardado.md'), false);

    fs.rmSync(target.fsPath);
  });

  test('never includes a secret file or a link that leaves the workspace', async () => {
    await vscode.commands.executeCommand('promptfold.clearChecks');
    await vscode.env.clipboard.writeText('');
    await withStubs({}, () =>
      vscode.commands.executeCommand(
        'promptfold.copyExplorerSelection',
        inWorkspace('web/src/app.ts'),
        [
          inWorkspace('web/src/app.ts'),
          inWorkspace('api/.env'),
          inWorkspace('api/certs/server.pem'),
          inWorkspace('ext'),
          inWorkspace('ext/id_rsa')
        ]
      )
    );

    const xml = await vscode.env.clipboard.readText();

    assert.ok(xml.includes('<file name="web/src/app.ts">'));
    assert.equal(xml.includes('super-secret-token'), false);
    assert.equal(xml.includes('PEM PRIVATE MATERIAL'), false);
    assert.equal(xml.includes('PRIVATE KEY MATERIAL'), false);
    assert.equal(xml.includes('id_rsa'), false);
  });

  test('uses the unsaved text of an open editor instead of the file on disk', async () => {
    const target = inWorkspace('web/src/app.ts');
    const document = await vscode.workspace.openTextDocument(target);
    const edit = new vscode.WorkspaceEdit();

    edit.insert(target, new vscode.Position(0, 0), '// unsaved-edit\n');
    await vscode.workspace.applyEdit(edit);

    await vscode.env.clipboard.writeText('');
    await withStubs({}, () =>
      vscode.commands.executeCommand(
        'promptfold.copyExplorerSelection',
        target,
        [target]
      )
    );

    const xml = await vscode.env.clipboard.readText();

    assert.equal(document.isDirty, true);
    assert.ok(xml.includes('// unsaved-edit'));
    assert.equal(
      fs.readFileSync(target.fsPath, 'utf8').includes('unsaved'),
      false
    );

    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('over both the byte limit and the token budget asks once, about bytes', async () => {
    const warnings = await copyWarnings({ maxTotalBytes: 10, tokenBudget: 1 });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /promptfold\.maxTotalBytes/);
    assert.deepEqual(warnings[0].actions, ['Copy what fits', 'Cancel']);
  });

  test('over only the token budget asks once and can be silenced for the workspace', async () => {
    const warnings = await copyWarnings({ tokenBudget: 1 });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /promptfold\.tokenBudget/);
    assert.deepEqual(warnings[0].actions, [
      'Copy anyway',
      'Do not ask again in this workspace',
      'Cancel'
    ]);
  });

  test('changing the token budget brings the silenced notice back', async () => {
    const silence = (message: string, actions: string[]) =>
      actions.find(action => action.startsWith('Do not ask again'));

    const tokenNotices = () =>
      withStubs({}, async recording => {
        await vscode.commands.executeCommand('promptfold.copyFiles');

        return recording.messages.filter(entry =>
          entry.actions.includes('Copy anyway')
        );
      });

    await withSettings({ tokenBudget: 1 }, async () => {
      await withStubs({ warningChoice: silence }, () =>
        vscode.commands.executeCommand('promptfold.copyFiles')
      );

      assert.equal((await tokenNotices()).length, 0);

      await vscode.workspace
        .getConfiguration('promptfold')
        .update('tokenBudget', 2, vscode.ConfigurationTarget.Workspace);

      assert.equal((await tokenNotices()).length, 1);
    });
  });

  test('stays quiet while the selection fits the token budget', async () => {
    const warnings = await copyWarnings({ tokenBudget: 100000000 });

    assert.equal(warnings.length, 0);
  });

  test('selecting the whole project leaves a lockfile out and says so', async () => {
    await vscode.commands.executeCommand('promptfold.clearChecks');
    await vscode.commands.executeCommand('promptfold.selectAll');

    const xml = await copyWith('promptfold.copyAsXml');

    assert.ok(xml.includes('<file name="web/src/app.ts">'));
    assert.equal(xml.includes('GENERATED-LOCK-MARKER'), false);
    assert.equal(xml.includes('web/package-lock.json'), false);
    assert.match(await detailsText(), /web\/package-lock\.json — generated/);
  });

  test('a lockfile checked on its own goes into the prompt', async () => {
    const lock = inWorkspace('web/package-lock.json');

    await vscode.env.clipboard.writeText('');
    await withStubs({}, () =>
      vscode.commands.executeCommand('promptfold.copyExplorerSelection', lock, [
        lock
      ])
    );

    const xml = await vscode.env.clipboard.readText();

    assert.ok(xml.includes('GENERATED-LOCK-MARKER'));
  });

  test('copying a folder from the Explorer skips the lockfile inside it', async () => {
    const folder = inWorkspace('web');

    await vscode.env.clipboard.writeText('');
    await withStubs({}, () =>
      vscode.commands.executeCommand(
        'promptfold.copyExplorerSelection',
        folder,
        [folder]
      )
    );

    const xml = await vscode.env.clipboard.readText();

    assert.ok(xml.includes('<file name="web/src/app.ts">'));
    assert.equal(xml.includes('GENERATED-LOCK-MARKER'), false);
    assert.match(await detailsText(), /web\/package-lock\.json — generated/);
  });
});
