import fs from 'fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'os';
import path from 'path';

import { DiffMode } from '../src/domain/entities/diff-mode.enum';
import { IgnoreReason } from '../src/domain/entities/ignore-reason.enum';
import { OutputFormat } from '../src/domain/entities/output-format.enum';
import { renderPrompt } from '../src/domain/services/prompt-formats.service';
import {
  filesSelectedByFolder,
  filesSelectedByFolderAsync
} from '../src/infrastructure/filesystem/select-files.walker';
import { generatedPatterns } from '../src/infrastructure/ignore/generated-patterns.constant';
import { createIgnoreResolver } from '../src/infrastructure/ignore/ignore-resolver.service';
import { PromptRepositoryImpl } from '../src/infrastructure/repositories/prompt.repository.impl';

import {
  DiskFilesDataSource,
  defaultLimits
} from './support/prompt-repository';

const GENERATED_NAMES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'composer.lock',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'bun.lock',
  'deno.lock',
  'uv.lock',
  'Pipfile.lock',
  'go.sum',
  'pubspec.lock',
  'packages.lock.json'
];

const GENERATED_PATHS = [
  ...GENERATED_NAMES,
  ...GENERATED_NAMES.map(name => `packages/web/${name}`),
  'public/app.min.js',
  'public/app.min.css',
  'assets/app.js.map',
  'src/app.tsbuildinfo'
];

const NEIGHBOURS = [
  'package.json',
  'composer.json',
  'src/app.ts',
  'src/lockfile.ts',
  'docs/go.sum.md',
  'src/min.js.ts'
];

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'f2p-generated-'));

const write = (root: string, relativePath: string, content = 'x') => {
  const fullPath = path.join(root, relativePath);

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);

  return fullPath;
};

const repositoryFor = (workspace: string, includeGenerated = false) => {
  const resolver = createIgnoreResolver({
    workspaceRoot: workspace,
    includeGenerated
  });

  return new PromptRepositoryImpl(
    workspace,
    new DiskFilesDataSource(),
    {
      promptSettings: () => ({
        outputFormat: OutputFormat.Xml,
        diffMode: DiffMode.DiffAndFiles,
        ...defaultLimits
      })
    },
    {
      resolvePath: resolver.resolve,
      isSkippedGenerated: resolver.isSkippedGenerated
    }
  );
};

test('the pattern list names every lockfile and generated asset', () => {
  assert.equal(generatedPatterns.length, 19);

  for (const name of [
    ...GENERATED_NAMES,
    '*.min.js',
    '*.min.css',
    '*.map',
    '*.tsbuildinfo'
  ]) {
    assert.ok(generatedPatterns.includes(name), name);
  }
});

test('a plain decision keeps a lockfile, a bulk decision skips it', () => {
  const resolver = createIgnoreResolver({ workspaceRoot: makeRoot() });

  for (const generated of GENERATED_PATHS) {
    assert.equal(resolver.resolve(generated, 'file').included, true, generated);

    const bulk = resolver.resolveBulk(generated, 'file');

    assert.equal(bulk.included, false, generated);
    assert.equal(bulk.reason, IgnoreReason.Generated, generated);
    assert.equal(resolver.isSkippedGenerated(generated), true, generated);
  }
});

test('look-alike names and folders are never generated', () => {
  const resolver = createIgnoreResolver({ workspaceRoot: makeRoot() });

  for (const neighbour of NEIGHBOURS) {
    assert.equal(resolver.resolveBulk(neighbour, 'file').included, true);
    assert.equal(resolver.isSkippedGenerated(neighbour), false);
  }

  assert.equal(resolver.resolveBulk('yarn.lock', 'directory').included, true);
});

test('includeGenerated brings generated files back into bulk selection', () => {
  const resolver = createIgnoreResolver({
    workspaceRoot: makeRoot(),
    includeGenerated: true
  });

  assert.equal(
    resolver.resolveBulk('package-lock.json', 'file').included,
    true
  );

  assert.equal(resolver.isSkippedGenerated('package-lock.json'), false);
});

test('other reasons still win over generated in a bulk decision', () => {
  const root = makeRoot();

  write(root, '.gitignore', 'yarn.lock\n');

  const resolver = createIgnoreResolver({ workspaceRoot: root });

  assert.equal(
    resolver.resolveBulk('yarn.lock', 'file').reason,
    IgnoreReason.Gitignore
  );

  assert.equal(
    createIgnoreResolver({ workspaceRoot: makeRoot() }).resolveBulk(
      'node_modules/a/yarn.lock',
      'file'
    ).reason,
    IgnoreReason.BuiltIn
  );
});

const relativeTo = (root: string, files: string[]) =>
  files.map(file => path.relative(root, file).split(path.sep).join('/'));

test('one walk skips lockfiles and reports them as generated', () => {
  const root = makeRoot();

  write(root, 'package.json');
  write(root, 'package-lock.json');
  write(root, 'src/app.ts');
  write(root, 'packages/web/yarn.lock');
  write(root, 'public/app.min.js');

  const resolver = createIgnoreResolver({ workspaceRoot: root });
  const generated: string[] = [];

  const selected = filesSelectedByFolder(
    root,
    root,
    resolver.resolveBulk,
    [],
    generated
  );

  assert.deepEqual(relativeTo(root, selected), ['package.json', 'src/app.ts']);

  assert.deepEqual(relativeTo(root, generated.sort()), [
    'package-lock.json',
    'packages/web/yarn.lock',
    'public/app.min.js'
  ]);
});

test('the async walk reports generated files and ignores pruned folders', async () => {
  const root = makeRoot();

  write(root, 'node_modules/pkg/yarn.lock');
  write(root, 'api/composer.lock');
  write(root, 'src/app.ts');

  const resolver = createIgnoreResolver({ workspaceRoot: root });
  const generatedFiles: string[] = [];

  const result = await filesSelectedByFolderAsync(
    root,
    root,
    resolver.resolveBulk,
    { generatedFiles }
  );

  assert.deepEqual(relativeTo(root, result.files), ['src/app.ts']);
  assert.deepEqual(relativeTo(root, generatedFiles), ['api/composer.lock']);
});

test('the build lists the skipped files it was given without recomputing them', async () => {
  const workspace = makeRoot();
  const app = write(workspace, 'src/app.ts', 'export const app = 1;');

  write(workspace, 'package-lock.json', '{"lock":true}');

  const result = await repositoryFor(workspace).build({
    filePaths: [app],
    skippedGenerated: ['package-lock.json', 'packages/web/yarn.lock']
  });

  assert.deepEqual(
    result.omittedFiles.map(file => [file.path, file.reason]),
    [
      ['package-lock.json', 'generated'],
      ['packages/web/yarn.lock', 'generated']
    ]
  );

  assert.equal(result.output.includes('{"lock":true}'), false);
});

test('without a skipped list the build omits nothing as generated', async () => {
  const workspace = makeRoot();
  const app = write(workspace, 'src/app.ts', 'export const app = 1;');

  write(workspace, 'package-lock.json', '{"lock":true}');

  const result = await repositoryFor(workspace).build({ filePaths: [app] });

  assert.deepEqual(result.omittedFiles, []);
});

test('a lockfile checked on its own goes into the prompt', async () => {
  const workspace = makeRoot();
  const lock = write(workspace, 'package-lock.json', '{"lock":true}');

  const result = await repositoryFor(workspace).build({ filePaths: [lock] });

  assert.deepEqual(
    result.included.map(file => file.name),
    ['package-lock.json']
  );

  assert.equal(result.output.includes('{"lock":true}'), true);
});

test('the change of a lockfile is listed without its diff in every format', async () => {
  const workspace = makeRoot();
  const changes = [
    {
      repo: 'api',
      path: 'composer.lock',
      status: 'modified',
      scope: 'uncommitted',
      diff: '+huge-lock-diff'
    },
    {
      repo: 'api',
      path: 'src/app.ts',
      status: 'modified',
      scope: 'uncommitted',
      diff: '+real-diff'
    }
  ];

  const outputs: Record<string, string> = {};

  for (const format of Object.values(OutputFormat)) {
    const result = await new PromptRepositoryImpl(
      workspace,
      new DiskFilesDataSource(),
      {
        promptSettings: () => ({
          outputFormat: format,
          diffMode: DiffMode.DiffOnly,
          ...defaultLimits
        })
      },
      {
        resolvePath: () => ({ included: true }),
        isSkippedGenerated: path => path === 'composer.lock'
      }
    ).build({ filePaths: [], changes });

    outputs[format] = result.output;

    assert.equal(result.output.includes('huge-lock-diff'), false, format);
    assert.equal(result.output.includes('real-diff'), true, format);
  }

  assert.match(
    outputs[OutputFormat.Xml],
    /<change path="composer\.lock" status="modified" generated="true"\/>/
  );

  assert.match(
    outputs[OutputFormat.Markdown],
    /### composer\.lock \(modified\)\n_Generated file, diff omitted\._/
  );

  assert.match(
    outputs[OutputFormat.Plain],
    /=== DIFF composer\.lock \(modified, generated, diff omitted\) ===/
  );
});

test('a generated change never leaks its diff through the formatter', () => {
  const change = {
    repo: 'api',
    path: 'yarn.lock',
    status: 'modified',
    generated: true,
    diff: 'must-not-appear'
  };

  for (const format of Object.values(OutputFormat)) {
    const rendered = renderPrompt(format, { files: [], changes: [change] });

    assert.equal(rendered.includes('must-not-appear'), false, format);
  }
});
