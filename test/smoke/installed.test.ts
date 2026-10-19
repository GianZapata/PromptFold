import fs from 'fs';
import assert from 'node:assert/strict';
import path from 'path';

import * as vscode from 'vscode';

const EXTENSION_ID = 'gianzapata.promptfold';

suite('Promptfold installed from the packaged VSIX', () => {
  test('activates the installed copy, not the development folder', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);

    assert.ok(extension, `${EXTENSION_ID} is not installed`);
    await extension.activate();

    const installedIn = fs.realpathSync(process.env.F2P_EXTENSIONS_DIR ?? '');
    const location = fs.realpathSync(extension.extensionPath);

    assert.equal(extension.isActive, true);
    assert.equal(
      path.relative(installedIn, location).startsWith('..'),
      false,
      `${location} is outside ${installedIn}`
    );

    assert.equal(extension.packageJSON.version, process.env.F2P_VERSION);
  });

  test('runs in the requested editor', () => {
    const expected = process.env.F2P_EDITOR_VERSION ?? '';

    if (/^\d+\.\d+\.\d+$/.test(expected)) {
      assert.equal(vscode.version, expected);
    } else {
      assert.match(vscode.version, /^\d+\.\d+\.\d+/);
    }
  });

  test('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);

    for (const command of [
      'promptfold.copyFiles',
      'promptfold.selectChanges',
      'promptfold.savePromptAs'
    ]) {
      assert.ok(commands.includes(command), `${command} is not registered`);
    }
  });
});
