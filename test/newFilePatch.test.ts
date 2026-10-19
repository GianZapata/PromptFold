import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EMPTY_TREE,
  fillChangeDiff,
  listCommitChanges,
  type DiffReader
} from '../src/domain/services/git-diff.service';

const cases = [
  { name: 'one final newline', content: 'hello\n', expected: 'hello\n' },
  { name: 'no final newline', content: 'hello', expected: 'hello' },
  { name: 'empty file', content: '', expected: '' },
  {
    name: 'intentional blank lines',
    content: 'hello\n\n\n',
    expected: 'hello\n\n\n'
  },
  {
    name: 'crlf normalized as lf',
    content: 'one\r\ntwo\r\n',
    expected: 'one\ntwo\n'
  }
];

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

const initRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-src-'));

  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'core.autocrlf', 'false']);

  return dir;
};

const parentOf = (cwd: string, hash: string) => {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${hash}^`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch {
    return undefined;
  }
};

const readerFor = (content: string): DiffReader => ({
  diffWithHEAD: async () => '',
  diffIndexWithHEAD: async () => '',
  diffBetween: async () => '',
  getMergeBase: async () => undefined,
  readFile: async () => content,
  show: async () => content,
  parentOf: async () => undefined
});

const appliedBytes = (patch: string, fileName: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-patch-'));

  git(dir, ['init', '-q']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, 'change.patch'), patch);
  execFileSync('git', ['apply', 'change.patch'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return fs.readFileSync(path.join(dir, fileName));
};

const appliedText = (patch: string, fileName: string) =>
  appliedBytes(patch, fileName).toString('utf8');

for (const sample of cases) {
  test(`pure new-file patch keeps ${sample.name}`, async () => {
    const loaded = await fillChangeDiff(
      readerFor(sample.content),
      { path: 'notes.txt', status: 'untracked' },
      'uncommitted'
    );

    assert.equal(appliedText(loaded.diff ?? '', 'notes.txt'), sample.expected);
    assert.equal(loaded.diff?.includes('\r'), false);
  });

  test(`uncommitted new file keeps ${sample.name}`, async () => {
    const source = initRepo();

    fs.writeFileSync(path.join(source, 'notes.txt'), sample.content);

    const loaded = await fillChangeDiff(
      {
        ...readerFor(''),
        readFile: async filePath =>
          fs.readFileSync(path.join(source, filePath), 'utf8')
      },
      { path: 'notes.txt', status: 'untracked' },
      'uncommitted'
    );

    assert.equal(appliedText(loaded.diff ?? '', 'notes.txt'), sample.expected);
  });

  test(`root commit fallback keeps ${sample.name}`, async () => {
    const source = initRepo();
    const calls: string[] = [];

    fs.writeFileSync(path.join(source, 'notes.txt'), sample.content);
    git(source, ['add', 'notes.txt']);
    git(source, ['commit', '-qm', 'root']);

    const hash = git(source, ['rev-parse', 'HEAD']).trim();
    const listed = await listCommitChanges(
      {
        parentOf: async ref => parentOf(source, ref),
        diffBetween: async (from, to) => {
          calls.push(`between:${from}:${to}`);
          throw new Error('diffBetween must not run for a root commit');
        },
        diffBlobs: async (from, to) => {
          calls.push(`blobs:${from}:${to}`);

          return git(source, ['diff', from, to]);
        }
      },
      hash
    );

    const loaded = await fillChangeDiff(
      {
        ...readerFor(''),
        parentOf: async ref => parentOf(source, ref),
        show: async (ref, filePath) =>
          git(source, ['show', `${ref}:${filePath}`]),
        diffBetween: async (from, to, filePath) => {
          calls.push(`between:${from}:${to}:${filePath}`);
          throw new Error('diffBetween must not run for a root commit');
        }
      },
      { path: 'notes.txt', status: 'added' },
      'commit',
      { commit: hash }
    );

    assert.equal(
      listed.some(item => item.path === 'notes.txt'),
      true
    );

    assert.equal(calls.includes(`blobs:${EMPTY_TREE}:${hash}`), true);

    assert.equal(
      calls.some(call => call.startsWith('between:')),
      false
    );

    assert.equal(appliedText(loaded.diff ?? '', 'notes.txt'), sample.expected);
  });
}
