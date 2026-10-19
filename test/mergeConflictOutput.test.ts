import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OutputFormat } from '../src/domain/entities/output-format.enum';
import {
  changesForScope,
  changesFromGitState
} from '../src/domain/services/git-changes.service';
import {
  fillChangeDiff,
  type DiffReader
} from '../src/domain/services/git-diff.service';
import { renderPrompt } from '../src/domain/services/prompt-formats.service';

const REPO = 'api';
const DELETED_BY_THEM = 13;
const BOTH_MODIFIED = 18;

const git = (cwd: string, args: string[], allowFailure = false) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    if (allowFailure) return '';

    throw error;
  }
};

const initRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-merge-'));

  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'core.autocrlf', 'false']);

  return dir;
};

const commitFile = (
  dir: string,
  name: string,
  content: string,
  message: string
) => {
  fs.writeFileSync(path.join(dir, name), content);
  git(dir, ['add', name]);
  git(dir, ['commit', '-qm', message]);
};

const readerFor = (dir: string, reads: string[]): DiffReader => ({
  diffWithHEAD: async () => {
    throw new Error('diffWithHEAD is not the merge diff');
  },
  diffIndexWithHEAD: async () => {
    throw new Error('the index diff is not the merge diff');
  },
  diffBetween: async () => {
    throw new Error('diffBetween is not used for an uncommitted conflict');
  },
  getMergeBase: async () => undefined,
  diffWith: async (ref, filePath) => git(dir, ['diff', ref, '--', filePath]),
  readFile: async filePath => {
    reads.push(filePath);
    throw new Error(`failed read must not become empty content: ${filePath}`);
  }
});

const promptFor = async (
  dir: string,
  groups: Parameters<typeof changesFromGitState>[0],
  reads: string[]
) => {
  const collected = changesFromGitState(groups);
  const listed = changesForScope(
    {
      repo: REPO,
      staged: collected.staged,
      working: collected.working,
      untracked: collected.untracked,
      commit: [],
      branch: []
    },
    'uncommitted'
  );

  const changes = [];

  for (const change of listed) {
    const relative = change.path.startsWith(`${REPO}/`)
      ? change.path.slice(REPO.length + 1)
      : change.path;

    const loaded = await fillChangeDiff(
      readerFor(dir, reads),
      { path: relative, status: change.status },
      'uncommitted'
    );

    changes.push({
      ...change,
      scope: 'uncommitted',
      diff: loaded.diff
    });
  }

  return {
    changes,
    xml: renderPrompt(OutputFormat.Xml, { files: [], changes }),
    markdown: renderPrompt(OutputFormat.Markdown, { files: [], changes }),
    plain: renderPrompt(OutputFormat.Plain, { files: [], changes })
  };
};

const changeCount = (
  format: OutputFormat,
  output: string,
  filePath: string
) => {
  if (format === OutputFormat.Xml) {
    return output.split(`path="${filePath}"`).length - 1;
  }

  if (format === OutputFormat.Markdown) {
    return output.split(`### ${filePath}`).length - 1;
  }

  return output.split(`=== DIFF ${filePath}`).length - 1;
};

test('a path that exists only in mergeChanges reaches the serialized prompt', async () => {
  const dir = initRepo();

  commitFile(dir, 'both.txt', 'base\n', 'base');
  git(dir, ['checkout', '-q', '-b', 'other']);
  commitFile(dir, 'both.txt', 'theirs\n', 'theirs');
  git(dir, ['checkout', '-q', 'main']);
  commitFile(dir, 'both.txt', 'ours\n', 'ours');
  git(dir, ['merge', 'other'], true);

  const reads: string[] = [];
  const prompt = await promptFor(
    dir,
    { mergeChanges: [{ path: 'both.txt', status: BOTH_MODIFIED }] },
    reads
  );

  const diff = prompt.changes[0]?.diff ?? '';

  assert.equal(prompt.changes.length, 1);
  assert.equal(prompt.changes[0]?.path, `${REPO}/both.txt`);
  assert.match(diff, /<<<<<<< HEAD/);
  assert.match(diff, /theirs/);
  assert.equal(reads.length, 0);

  for (const format of [
    OutputFormat.Xml,
    OutputFormat.Markdown,
    OutputFormat.Plain
  ]) {
    const output = prompt[format];

    assert.equal(changeCount(format, output, `${REPO}/both.txt`), 1);
    assert.match(output, /<<<<<<< HEAD/);
  }
});

test('a deletion conflict stays reported when the file is absent', async () => {
  const dir = initRepo();

  commitFile(dir, 'gone.txt', 'base line\n', 'base');
  git(dir, ['checkout', '-q', '-b', 'other']);
  git(dir, ['rm', '-q', 'gone.txt']);
  git(dir, ['commit', '-qm', 'delete on other']);
  git(dir, ['checkout', '-q', 'main']);
  commitFile(dir, 'gone.txt', 'ours line\n', 'edit on main');
  git(dir, ['merge', 'other'], true);
  fs.rmSync(path.join(dir, 'gone.txt'));

  const reads: string[] = [];
  const prompt = await promptFor(
    dir,
    { mergeChanges: [{ path: 'gone.txt', status: DELETED_BY_THEM }] },
    reads
  );

  const diff = prompt.changes[0]?.diff ?? '';

  assert.equal(prompt.changes.length, 1);
  assert.equal(prompt.changes[0]?.path, `${REPO}/gone.txt`);
  assert.match(diff, /deleted file mode/);
  assert.match(diff, /-ours line/);
  assert.equal(diff.includes('new file mode'), false);
  assert.equal(reads.length, 0);

  for (const format of [
    OutputFormat.Xml,
    OutputFormat.Markdown,
    OutputFormat.Plain
  ]) {
    const output = prompt[format];

    assert.equal(changeCount(format, output, `${REPO}/gone.txt`), 1);
    assert.match(output, /deleted file mode/);
    assert.equal(output.includes('new file mode'), false);
  }
});
