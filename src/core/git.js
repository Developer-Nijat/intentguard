/**
 * Minimal git plumbing via the git executable. Everything degrades gracefully
 * when git is missing or the project is not a repository.
 */
import { execFileSync } from 'node:child_process';
import { normalizePath } from './scope-matcher.js';

function git(root, args) {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryGit(root, args) {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

export function isGitRepo(root) {
  return tryGit(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

export function hasCommits(root) {
  return tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== null;
}

export function commitExists(root, sha) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  if (!isGitRepo(root)) return null;
  return tryGit(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

const lines = (output) => (output ?? '').split(/\r?\n/).filter(Boolean);

/** Tracked + untracked (not ignored) files under `root`, relative to `root`. */
export function listFiles(root) {
  const output = tryGit(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
  return output === null ? null : [...new Set(lines(output).map(normalizePath))];
}

/**
 * Files changed in the working tree.
 * @param {{ staged?: boolean, base?: string }} options
 * @returns {{ path: string, status: 'added'|'modified'|'deleted' }[] | null} null when not in a git repo.
 */
export function changedFiles(root, options = {}) {
  if (!isGitRepo(root)) return null;
  const prefix = normalizePath(tryGit(root, ['rev-parse', '--show-prefix'])?.trim() ?? '');
  const relativeToRoot = (file) => {
    const normalized = normalizePath(file);
    if (!prefix) return normalized;
    return normalized.startsWith(`${prefix}/`) ? normalized.slice(prefix.length + 1) : null;
  };

  const changes = new Map();
  const add = (file, status) => {
    const rel = relativeToRoot(file);
    if (rel) changes.set(rel, status);
  };

  if (!hasCommits(root)) {
    for (const file of listFiles(root) ?? []) changes.set(file, 'added');
    return [...changes].map(([path, status]) => ({ path, status }));
  }

  const range = diffRange(options);
  for (const line of lines(tryGit(root, ['diff', '--name-status', '--no-renames', ...range]))) {
    const [code, ...rest] = line.split('\t');
    const file = rest[rest.length - 1];
    if (!file) continue;
    add(file, code.startsWith('D') ? 'deleted' : code.startsWith('A') ? 'added' : 'modified');
  }
  if (!options.staged) {
    for (const file of lines(tryGit(root, ['ls-files', '--others', '--exclude-standard', '--full-name']))) {
      add(file, 'added');
    }
  }
  return [...changes].map(([path, status]) => ({ path, status }));
}

function diffRange(options) {
  if (options.staged) return ['--cached'];
  if (options.base) return [options.base];
  return ['HEAD'];
}

/**
 * Lines added to one file, grouped into contiguous segments.
 * @returns {{ startLine: number, text: string }[]}
 */
export function addedSegments(root, file, options = {}) {
  const output = tryGit(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', ...diffRange(options), '--', file]);
  return parseAddedSegments(output ?? '');
}

/** Parse a zero-context unified diff into segments of added lines. */
export function parseAddedSegments(diff) {
  const segments = [];
  let current = null;
  let nextLine = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      inHunk = true;
      nextLine = Number(header[1]);
      current = null;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      const text = line.slice(1).replace(/\r$/, '');
      if (!current) {
        current = { startLine: nextLine, lines: [] };
        segments.push(current);
      }
      current.lines.push(text);
      nextLine++;
    } else if (line.startsWith('-') || line.startsWith('\\')) {
      current = current && line.startsWith('\\') ? current : null;
    } else if (line.startsWith('diff --git')) {
      inHunk = false;
      current = null;
    }
  }
  return segments.map((segment) => ({ startLine: segment.startLine, text: segment.lines.join('\n') }));
}
