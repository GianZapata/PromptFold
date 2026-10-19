import fs from 'fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'path';

import { readJson } from './support/manifest';

const SOURCE_ROOT = path.join(__dirname, '../../src');

const LITERAL_CALL =
  /l10n\.t\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;

const BUILT_ELSEWHERE = [
  'Copied {0} files. Omitted {1} files and {2} folders.',
  'Copy stopped because the file limit was reached. {0} files are still pending.',
  'Copy stopped because the prompt is too large. {0} files are still pending.',
  'Copy cancelled. Collected files were not copied.',
  'Copy stopped. {0} files are still pending.',
  'Saved {0} files to {1}. Omitted {2} files and {3} folders.',
  'Prompt preview opened.',
  'Preview includes {0} files. {1} were left out because the prompt is too large. Change promptfold.maxTotalBytes.',
  'Preview includes {0} files. {1} were left out because the file limit was reached. Change promptfold.maxFiles.',
  'Preview includes {0} files. {1} were left out.',
  'This selection has {0} files, {1} over the limit of {2}. Change promptfold.maxFiles, copy what fits, or cancel.',
  'This selection is about {0}, {1} over the limit of {2}. Change promptfold.maxTotalBytes, copy what fits, or cancel.',
  'This selection is about {0} tokens, {1} over the budget of {2}. Change promptfold.tokenBudget, copy anyway, or cancel.',
  'git · {0}',
  'submodule · {0}',
  'Git is not available in this window.',
  'No Git repositories in this workspace.',
  'Current changes',
  'Staged only',
  'Advanced',
  'A specific commit',
  'Compare branch',
  'Added',
  'Deleted',
  'Renamed',
  'Submodule',
  'Modified',
  'XML',
  'Markdown',
  'Plain text',
  'Reveal in Finder',
  'Reveal in File Explorer',
  'Reveal in file manager',
  'generated · included manually',
  'generated · left out of bulk selection',
  'No changes to include in {0}.'
];

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(fullPath);
    }

    return entry.name.endsWith('.ts') ? [fullPath] : [];
  });

const unescape = (literal: string) =>
  literal.replace(/\\(.)/g, (_match, char: string) =>
    char === 'n' ? '\n' : char
  );

const allSource = () =>
  sourceFiles(SOURCE_ROOT)
    .map(file => fs.readFileSync(file, 'utf8'))
    .join('\n');

const literalKeys = () => {
  const keys = new Set<string>();

  for (const match of allSource().matchAll(LITERAL_CALL)) {
    keys.add(unescape(match[1] ?? match[2] ?? match[3] ?? ''));
  }

  return [...keys];
};

const bundle = () =>
  readJson<Record<string, string>>('l10n/bundle.l10n.es.json');

test('every literal passed to l10n.t has a Spanish translation', () => {
  const translations = bundle();
  const keys = literalKeys();

  assert.ok(keys.length > 0, 'the scan found no l10n.t literals');

  for (const key of keys) {
    assert.equal(typeof translations[key], 'string', `es is missing "${key}"`);
  }
});

test('every message that reaches l10n.t through a variable has a Spanish translation', () => {
  const translations = bundle();

  for (const key of BUILT_ELSEWHERE) {
    assert.equal(typeof translations[key], 'string', `es is missing "${key}"`);
  }
});

test('the list of messages built elsewhere still matches the source', () => {
  const source = allSource();

  for (const key of BUILT_ELSEWHERE) {
    const escaped = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    assert.ok(
      source.includes(key) || source.includes(escaped),
      `"${key}" is not in src any more, so remove it from the list`
    );
  }
});

test('no Spanish translation is empty', () => {
  for (const [key, value] of Object.entries(bundle())) {
    assert.notEqual(value.trim(), '', `"${key}" has an empty translation`);
  }
});
