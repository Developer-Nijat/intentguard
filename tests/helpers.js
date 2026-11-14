import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli/index.js';
import { openContext } from '../src/core/context.js';
import { initProjectFiles } from '../src/core/project.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(REPO, 'bin', 'intentguard.js');

export function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const createTemp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'intentguard-test-')));
const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

/** A throwaway directory, removed when the test finishes. */
export function tempDir(t) {
  const dir = createTemp();
  t.after(() => removeDir(dir));
  return dir;
}

/** An initialised IntentGuard project with an open context. */
export function makeProject(t, files = {}, configOverrides = {}) {
  const root = createTemp();
  initProjectFiles(root, configOverrides);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  const ctx = openContext(root);
  // Close the database before deleting its directory (Windows keeps open files locked).
  t.after(() => {
    ctx.close();
    removeDir(root);
  });
  return { root, ctx };
}

/** Run the CLI in-process and capture its output. */
export async function cli(cwd, ...args) {
  const out = [];
  const err = [];
  const code = await main(args, { out: (text) => out.push(text), err: (text) => err.push(text), cwd });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Run the real executable (used where process-level behaviour matters). */
export function runBin(cwd, args, input = '') {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', windowsHide: true });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

export const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

/* --------------------------------------------------------------- fixtures */

export const MONGO = {
  title: 'Frontend must never access MongoDB directly',
  decision: 'All data access from apps/web goes through the backend API.',
  reason: 'All business operations must pass through the backend authorization layer.',
  scope: ['apps/web/**'],
  constraints: [
    {
      rule: 'No MongoDB driver in the frontend',
      severity: 'high',
      patterns: ["from ['\"]mongo(db|ose)['\"]", "require\\(['\"]mongo(db|ose)['\"]\\)"],
      commandPatterns: ['npm (i|install|add) .*\\bmongo(db|ose)\\b'],
    },
  ],
  evidence: [{ source: 'docs/architecture.md', locator: 'section 3' }],
  alternatives: [{ title: 'Realm SDK in the browser', reason: 'Bypasses the authorization layer' }],
};

export const RABBIT = {
  title: 'Use RabbitMQ for async communication',
  decision: 'Services communicate asynchronously through RabbitMQ.',
  reason: 'Services must remain loosely coupled and failures isolated.',
  scope: ['services/**'],
  constraints: [{ rule: 'No direct synchronous HTTP calls between services', severity: 'high' }],
};

export const GENERATED = {
  title: 'Generated API client is never edited by hand',
  decision: 'Files under src/generated are produced by codegen.',
  reason: 'They are overwritten on every build, so manual edits are silently lost.',
  type: 'process',
  scope: ['src/generated/**'],
  constraints: [{ rule: 'Do not modify generated files', protect: true, severity: 'critical' }],
};

export const meta = { confirmed: true };
