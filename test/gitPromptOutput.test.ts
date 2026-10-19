import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OutputFormat } from '../src/domain/entities/output-format.enum';
import {
  changesForScope,
  changesFromGitState,
  type GitStatusGroups
} from '../src/domain/services/git-changes.service';
import {
  fillChangeDiff,
  type DiffReader
} from '../src/domain/services/git-diff.service';
import { renderPrompt } from '../src/domain/services/prompt-formats.service';

const REPO = 'api';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

const initRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-out-'));

  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'core.autocrlf', 'false']);

  return dir;
};

const readerFor = (dir: string): DiffReader => ({
  diffWithHEAD: async () => {
    throw new Error('diffWithHEAD is not the uncommitted combined diff');
  },
  diffIndexWithHEAD: async () => {
    throw new Error('the index diff omits the later edit');
  },
  diffBetween: async () => {
    throw new Error('diffBetween is not used for uncommitted output');
  },
  getMergeBase: async () => undefined,
  diffWith: async (ref, filePath) => git(dir, ['diff', ref, '--', filePath]),
  readFile: async filePath =>
    fs.readFileSync(path.join(dir, filePath), 'utf8')
});

const promptFor = async (dir: string, groups: GitStatusGroups) => {
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
      readerFor(dir),
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

test('mixed and separate untracked files are serialized once', async () => {
  const dir = initRepo();
  const content = 'fresh note\n';

  fs.writeFileSync(path.join(dir, 'notes.md'), content);
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-qm', 'seed']);

  const placements: GitStatusGroups[] = [
    { workingTreeChanges: [{ path: 'notes.md', status: 7 }] },
    { untrackedChanges: [{ path: 'notes.md', status: 7 }] }
  ];

  for (const groups of placements) {
    const prompt = await promptFor(dir, groups);

    assert.equal(prompt.changes.length, 1);
    assert.equal(prompt.changes[0]?.path, `${REPO}/notes.md`);
    assert.match(prompt.changes[0]?.diff ?? '', /\+fresh note/);

    for (const format of [
      OutputFormat.Xml,
      OutputFormat.Markdown,
      OutputFormat.Plain
    ]) {
      const output = prompt[format];

      assert.equal(changeCount(format, output, `${REPO}/notes.md`), 1);
      assert.match(output, /\+fresh note/);
    }
  }
});

test('hidden untracked files stay out of the serialized prompt', async () => {
  const dir = initRepo();

  fs.writeFileSync(path.join(dir, 'secret.md'), 'hidden-secret\n');
  fs.writeFileSync(path.join(dir, 'kept.ts'), 'export const kept = 1;\n');
  git(dir, ['add', 'kept.ts']);
  git(dir, ['commit', '-qm', 'seed']);
  fs.writeFileSync(path.join(dir, 'kept.ts'), 'export const kept = 2;\n');

  const prompt = await promptFor(dir, {
    workingTreeChanges: [{ path: 'kept.ts', status: 5 }]
  });

  assert.equal(
    prompt.changes.some(change => change.path.endsWith('secret.md')),
    false
  );

  for (const output of [prompt.xml, prompt.markdown, prompt.plain]) {
    assert.equal(output.includes('hidden-secret'), false);
    assert.equal(output.includes('secret.md'), false);
    assert.match(output, /kept\.ts/);
  }
});

test('a staged edit plus a later unstaged edit is serialized once', async () => {
  const dir = initRepo();

  fs.writeFileSync(path.join(dir, 'notes.md'), 'alpha\nkeep\n');
  git(dir, ['add', 'notes.md']);
  git(dir, ['commit', '-qm', 'seed']);
  fs.writeFileSync(path.join(dir, 'notes.md'), 'staged-line\nkeep\n');
  git(dir, ['add', 'notes.md']);
  fs.writeFileSync(path.join(dir, 'notes.md'), 'staged-line\nlater-line\n');

  const prompt = await promptFor(dir, {
    indexChanges: [{ path: 'notes.md', status: 0 }],
    workingTreeChanges: [{ path: 'notes.md', status: 5 }]
  });

  const diff = prompt.changes[0]?.diff ?? '';

  assert.equal(prompt.changes.length, 1);
  assert.match(diff, /staged-line/);
  assert.match(diff, /later-line/);
  assert.match(diff, /-alpha/);
  assert.match(diff, /-keep/);

  for (const format of [
    OutputFormat.Xml,
    OutputFormat.Markdown,
    OutputFormat.Plain
  ]) {
    const output = prompt[format];

    assert.equal(changeCount(format, output, `${REPO}/notes.md`), 1);
    assert.match(output, /staged-line/);
    assert.match(output, /later-line/);
  }
});
