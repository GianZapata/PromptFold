import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests
} from '@vscode/test-electron';

const vsix = path.resolve(process.argv[2] ?? '');
const only = process.argv[3];
const repoRoot = process.cwd();
const { version, engines } = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
);
const minimumVersion = engines.vscode.replace(/^[^\d]*/, '');
const targets = [
  { label: 'stable', version: 'stable' },
  { label: 'minimum', version: minimumVersion }
];
const selected = only
  ? targets.filter(target => target.label === only || target.version === only)
  : targets;

if (!fs.existsSync(vsix)) {
  throw new Error(`The VSIX was not found: ${vsix}`);
}

if (selected.length === 0) {
  throw new Error(`Unknown smoke target: ${only}`);
}

const smokeTarget = async target => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), `f2p-smoke-${target.label}-`)
  );
  const extensionsDir = path.join(temporary, 'extensions');
  const userDataDir = path.join(temporary, 'user-data');
  const workspace = path.join(temporary, 'workspace');

  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello\n');

  try {
    console.log(`Smoke ${target.label} (${target.version})`);

    const vscodeExecutablePath = await downloadAndUnzipVSCode(target.version);
    const [cli, ...cliArgs] =
      resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    const install = spawnSync(
      cli,
      [
        ...cliArgs,
        '--extensions-dir',
        extensionsDir,
        '--user-data-dir',
        userDataDir,
        '--install-extension',
        vsix
      ],
      { stdio: 'inherit', shell: process.platform === 'win32' }
    );

    if (install.status !== 0) {
      throw new Error(
        `Installing the VSIX failed with status ${install.status}`
      );
    }

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: path.join(repoRoot, 'test/smoke/host'),
      extensionTestsPath: path.join(repoRoot, 'out-test/smoke/index.js'),
      extensionTestsEnv: {
        F2P_EXTENSIONS_DIR: extensionsDir,
        F2P_VERSION: version,
        F2P_EDITOR_VERSION: target.version
      },
      launchArgs: [
        workspace,
        '--extensions-dir',
        extensionsDir,
        '--user-data-dir',
        userDataDir,
        '--disable-workspace-trust'
      ]
    });

    console.log(`Smoke ${target.label}: passed`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
};

const failures = [];

for (const target of selected) {
  try {
    await smokeTarget(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(`Smoke ${target.label}: failed`);
    failures.push(`${target.label}: ${message}`);
  }
}

if (failures.length > 0) {
  throw new Error(failures.join('\n'));
}
