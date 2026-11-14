import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWorkspace } from '../src/core/check.js';
import { grantException, recordDecision, resolveConflict } from '../src/core/decision-engine.js';
import { parseAddedSegments } from '../src/core/git.js';
import { GENERATED, MONGO, RABBIT, git, hasGit, makeProject, meta, write } from './helpers.js';

const IMPORT = "import { MongoClient } from 'mongodb';";

test('parseAddedSegments groups added lines with their line numbers', () => {
  const diff = [
    'diff --git a/a.js b/a.js',
    'index 111..222 100644',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -2,0 +3,2 @@ const a = 1;',
    '+const b = 2;',
    '+const c = 3;',
    '@@ -10 +12 @@',
    '-old line',
    '+new line',
    '\\ No newline at end of file',
  ].join('\n');
  assert.deepEqual(parseAddedSegments(diff), [
    { startLine: 3, text: 'const b = 2;\nconst c = 3;' },
    { startLine: 12, text: 'new line' },
  ]);
  assert.deepEqual(parseAddedSegments(''), []);
});

test('parseAddedSegments is not fooled by added lines that look like headers', () => {
  const diff = ['--- a/a.md', '+++ b/a.md', '@@ -1,0 +2,2 @@', '+++ not a header', '+--- also content'].join('\n');
  assert.deepEqual(parseAddedSegments(diff), [{ startLine: 2, text: '++ not a header\n--- also content' }]);
});

test('explicit files are checked in full, even without git', (t) => {
  const { root, ctx } = makeProject(t, { 'apps/web/db.js': `// db\n${IMPORT}\n`, 'apps/web/ok.js': 'export const a = 1;\n' });
  recordDecision(ctx, MONGO, meta);
  const result = checkWorkspace(ctx, { files: ['apps/web/db.js', `${root}/apps/web/ok.js`] });
  assert.equal(result.mode, 'files');
  assert.equal(result.checked, 2);
  assert.equal(result.verdict, 'potential_conflict');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].line, 2);
  assert.equal(result.findings[0].conflictId, 'CONF-0001');
});

test('--dry-run style checks record nothing', (t) => {
  const { ctx } = makeProject(t, { 'apps/web/db.js': IMPORT });
  recordDecision(ctx, MONGO, meta);
  const result = checkWorkspace(ctx, { files: ['apps/web/db.js'], record: false });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].conflictId, undefined);
  assert.equal(ctx.store.conflicts.list().length, 0);
});

test('files outside the project are refused', (t) => {
  const { ctx } = makeProject(t);
  assert.throws(() => checkWorkspace(ctx, { files: ['../elsewhere.js'] }), /outside the project/);
});

test('without git and without files the check explains what to do', (t) => {
  const { ctx } = makeProject(t);
  assert.throws(() => checkWorkspace(ctx, {}), /not a git repository.*intentguard check <file/s);
});

test('decisions without detectors are reported for semantic judgement', (t) => {
  const { ctx } = makeProject(t, { 'services/order/notify.js': "await fetch('http://notification/send');\n" });
  recordDecision(ctx, RABBIT, meta);
  const result = checkWorkspace(ctx, { files: ['services/order/notify.js'] });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.needsJudgement.map((entry) => [entry.decision.id, entry.files]), [['DEC-0001', ['services/order/notify.js']]]);
});

test('exceptions and dismissed false positives are reported separately, not as findings', (t) => {
  const { ctx } = makeProject(t, { 'apps/web/admin/a.js': IMPORT, 'apps/web/b.js': IMPORT });
  recordDecision(ctx, MONGO, meta);
  grantException(ctx, 'DEC-0001', { reason: 'Admin is server-side', scope: ['apps/web/admin/**'] });
  let result = checkWorkspace(ctx, { files: ['apps/web/admin/a.js', 'apps/web/b.js'] });
  assert.deepEqual(result.findings.map((f) => f.path), ['apps/web/b.js']);
  assert.deepEqual(result.excepted.map((e) => [e.path, e.exception.id]), [['apps/web/admin/a.js', 'EXC-0001']]);

  resolveConflict(ctx, result.findings[0].conflictId, 'false_positive', { note: 'type import' });
  result = checkWorkspace(ctx, { files: ['apps/web/b.js'] });
  assert.equal(result.findings.length, 0);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.verdict, 'compatible');
});

test('a deleted protected file is a violation', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, GENERATED, meta);
  const result = checkWorkspace(ctx, { files: ['src/generated/client.ts'] });
  assert.equal(result.files[0].status, 'deleted');
  assert.equal(result.verdict, 'confirmed_violation');
});

test('git: only added lines are judged, so existing code is not re-flagged', { skip: !hasGit }, (t) => {
  const { root, ctx } = makeProject(t, {
    'apps/web/old.js': `${IMPORT}\nexport const a = 1;\n`,
    'apps/web/page.js': 'export const page = 1;\n',
    'docs/architecture.md': '# Architecture\n',
  });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'baseline');
  recordDecision(ctx, MONGO, meta);

  assert.equal(checkWorkspace(ctx).checked, 0, 'clean tree');

  // touch a file that already violates, without adding a violation
  write(root, 'apps/web/old.js', `${IMPORT}\nexport const a = 2;\n`);
  // add a violation to a clean file, on line 3
  write(root, 'apps/web/page.js', `export const page = 1;\n\nconst mongoose = require('mongoose');\n`);
  // a brand-new untracked file
  write(root, 'apps/web/new.js', `${IMPORT}\n`);

  const result = checkWorkspace(ctx);
  assert.equal(result.mode, 'working tree');
  assert.equal(result.checked, 3);
  const byPath = Object.fromEntries(result.findings.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['apps/web/new.js', 'apps/web/page.js']);
  assert.equal(byPath['apps/web/page.js'].line, 3);
  assert.equal(byPath['apps/web/new.js'].line, 1);
});

test('git: staged mode looks at the index only', { skip: !hasGit }, (t) => {
  const { root, ctx } = makeProject(t, { 'apps/web/page.js': 'export const page = 1;\n' });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'baseline');
  recordDecision(ctx, MONGO, meta);

  write(root, 'apps/web/staged.js', `${IMPORT}\n`);
  git(root, 'add', 'apps/web/staged.js');
  write(root, 'apps/web/unstaged.js', `${IMPORT}\n`);

  const result = checkWorkspace(ctx, { staged: true });
  assert.equal(result.mode, 'staged');
  assert.deepEqual(result.findings.map((f) => f.path), ['apps/web/staged.js']);
});

test('git: IntentGuard never checks its own data directory', { skip: !hasGit }, (t) => {
  const { root, ctx } = makeProject(t, { 'a.js': 'x\n' });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'baseline');
  recordDecision(ctx, { title: 'Everything is protected', decision: 'd', reason: 'r', constraints: [{ rule: 'no edits', protect: true }] }, meta);
  write(root, '.intentguard/decisions.json', '{}');
  assert.equal(checkWorkspace(ctx).checked, 0);
});

test('git: a repository with no commits yet treats every file as new', { skip: !hasGit }, (t) => {
  const { root, ctx } = makeProject(t, { 'apps/web/db.js': `${IMPORT}\n` });
  git(root, 'init', '-q');
  recordDecision(ctx, MONGO, meta);
  const result = checkWorkspace(ctx);
  assert.deepEqual(result.findings.map((f) => f.path), ['apps/web/db.js']);
});
