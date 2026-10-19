import { GitChangeStatus } from '../entities/git-change-status.enum';
import { GitScope, type AnyGitScope } from '../entities/git-scope.enum';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const LINE_BREAK = /\r?\n/;

export const branchRangeBase = (
  mergeBase: string | undefined,
  baseName: string
) => (mergeBase && mergeBase !== 'HEAD' ? mergeBase : baseName);

export interface DiffReader {
  diffWithHEAD: (filePath: string) => Promise<string>;
  diffWith?: (ref: string, filePath: string) => Promise<string>;
  diffIndexWithHEAD: (filePath: string) => Promise<string>;
  diffBetween: (from: string, to: string, filePath: string) => Promise<string>;
  getMergeBase: (base: string, head: string) => Promise<string | undefined>;
  parentOf?: (hash: string) => Promise<string | undefined>;
  show?: (ref: string, filePath: string) => Promise<string>;
  readFile?: (filePath: string) => Promise<string>;
}

export type ListedCommitStatus =
  | GitChangeStatus.Added
  | GitChangeStatus.Modified
  | GitChangeStatus.Deleted
  | 'added'
  | 'modified'
  | 'deleted';

export interface ListedCommitChange {
  path: string;
  status: ListedCommitStatus;
}

const decodeGitQuoted = (body: string) => {
  const bytes: number[] = [];

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];

    if (char !== '\\') {
      bytes.push(char.charCodeAt(0));
      continue;
    }

    const next = body[index + 1];

    if (next === 't') {
      bytes.push(9);
      index += 1;
      continue;
    }

    if (next === 'n') {
      bytes.push(10);
      index += 1;
      continue;
    }

    if (next === '"') {
      bytes.push(34);
      index += 1;
      continue;
    }

    if (next === '\\') {
      bytes.push(92);
      index += 1;
      continue;
    }

    if (next < '0' || next > '7') {
      bytes.push(char.charCodeAt(0));
      continue;
    }

    let octal = '';

    while (
      octal.length < 3 &&
      index + 1 < body.length &&
      body[index + 1] >= '0' &&
      body[index + 1] <= '7'
    ) {
      index += 1;
      octal += body[index];
    }

    bytes.push(Number.parseInt(octal, 8));
  }

  return Buffer.from(bytes).toString('utf8');
};

const readGitPath = (line: string, start: number) => {
  if (line[start] === '"') {
    let body = '';
    let index = start + 1;

    while (index < line.length) {
      if (line[index] === '\\') {
        body += line[index] + (line[index + 1] ?? '');
        index += 2;
        continue;
      }

      if (line[index] === '"') {
        return { path: decodeGitQuoted(body), next: index + 1 };
      }

      body += line[index];
      index += 1;
    }

    return undefined;
  }

  const match = line.slice(start).match(/^\S+/);

  if (!match) {
    return undefined;
  }

  return { path: match[0], next: start + match[0].length };
};

const pathWithoutPrefix = (value: string) =>
  value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;

const identicalAbPath = (rest: string) => {
  if (!rest.startsWith('a/')) {
    return undefined;
  }

  const body = rest.slice(2);
  const needle = ' b/';
  let search = 0;

  while (search < body.length) {
    const index = body.indexOf(needle, search);

    if (index === -1) {
      return undefined;
    }

    const left = body.slice(0, index);
    const right = body.slice(index + needle.length);

    if (left.length > 0 && left === right) {
      return left;
    }

    search = index + 1;
  }

  return undefined;
};

const pathFromPlus = (raw: string) => {
  const token = raw.split('\t')[0]?.trim() ?? '';

  if (token.startsWith('"')) {
    const read = readGitPath(token, 0);

    return read ? pathWithoutPrefix(read.path) : undefined;
  }

  if (!token.startsWith('b/')) {
    return undefined;
  }

  return token.slice(2);
};

const plusPath = (lines: string[], start: number) => {
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].startsWith('diff --git ')) {
      return undefined;
    }

    if (lines[index].startsWith('+++ ')) {
      return pathFromPlus(lines[index].slice(4));
    }
  }

  return undefined;
};

const quotedBPath = (line: string) => {
  const left = readGitPath(line, 'diff --git '.length);

  if (!left) {
    return undefined;
  }

  const right = readGitPath(line, left.next + 1);

  return right ? pathWithoutPrefix(right.path) : undefined;
};

export const pathsFromPatch = (patch: string): ListedCommitChange[] => {
  const lines = patch.split(LINE_BREAK);
  const listed: ListedCommitChange[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.startsWith('diff --git ')) {
      continue;
    }

    const rest = line.slice('diff --git '.length);
    const path = rest.includes('"')
      ? quotedBPath(line)
      : (identicalAbPath(rest) ?? plusPath(lines, index + 1));

    if (!path) {
      continue;
    }

    listed.push({ path, status: 'added' });
  }

  return listed;
};

export interface ListCommitChangesReader {
  parentOf: (hash: string) => Promise<string | undefined>;
  diffBetween: (from: string, to: string) => Promise<ListedCommitChange[]>;
  diffBlobs: (from: string, to: string) => Promise<string>;
}

export const listCommitChanges = async (
  reader: ListCommitChangesReader,
  hash: string
) => {
  const parent = await reader.parentOf(hash);

  if (parent) {
    return reader.diffBetween(parent, hash);
  }

  return pathsFromPatch(await reader.diffBlobs(EMPTY_TREE, hash));
};

export interface DiffRequest {
  path: string;
  status: string;
  binary?: boolean;
}

export interface DiffRefs {
  commit?: string;
  base?: string;
}

export const fillChangeDiff = async (
  reader: DiffReader,
  change: DiffRequest,
  scope: AnyGitScope,
  refs: DiffRefs = {}
) => {
  if (change.binary) {
    return { binary: true as const };
  }

  if (scope === GitScope.Staged) {
    return { diff: withLf(await reader.diffIndexWithHEAD(change.path)) };
  }

  if (scope === GitScope.Uncommitted) {
    if (
      change.status === GitChangeStatus.Untracked ||
      change.status === GitChangeStatus.Added
    ) {
      const content = (await reader.readFile?.(change.path)) ?? '';

      return { diff: newFileDiff(change.path, content) };
    }

    return { diff: withLf(await reader.diffWith?.('HEAD', change.path)) };
  }

  if (scope === GitScope.Commit) {
    const hash = refs.commit ?? 'HEAD';
    const parent = await reader.parentOf?.(hash);

    if (parent) {
      return {
        diff: withLf(await reader.diffBetween(parent, hash, change.path))
      };
    }

    const content = (await reader.show?.(hash, change.path)) ?? '';

    return { diff: newFileDiff(change.path, content) };
  }

  const from = refs.base && refs.base !== 'HEAD' ? refs.base : undefined;

  if (!from) {
    return { diff: '' };
  }

  return {
    diff: withLf(await reader.diffBetween(from, 'HEAD', change.path))
  };
};

const withLf = (text: string | undefined) => text?.replace(/\r\n/g, '\n');

const newFileDiff = (filePath: string, content: string) => {
  const header = [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`
  ];

  const normalized = withLf(content) ?? '';

  if (normalized.length === 0) return `${header.join('\n')}\n`;

  const missingFinalNewline = !normalized.endsWith('\n');
  const recorded = missingFinalNewline ? normalized : normalized.slice(0, -1);

  const lines = recorded.split('\n');
  const hunk = [
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(line => `+${line}`)
  ];

  if (missingFinalNewline) hunk.push('\\ No newline at end of file');

  return `${[...header, ...hunk].join('\n')}\n`;
};
