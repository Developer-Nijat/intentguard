import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { evaluateFile, recordFindings } from '../src/core/conflict-engine.js';
import { grantException, markReviewed, recordDecision, reverifyEvidence } from '../src/core/decision-engine.js';
import { reviewDecisions } from '../src/core/drift.js';
import { evidenceFilePath, hashContent, hashFile, resolveEvidence } from '../src/core/evidence-resolver.js';
import { MONGO, RABBIT, makeProject, meta, write } from './helpers.js';

const signalsFor = (result, id) => (result.items.find((item) => item.decision.id === id)?.signals ?? []).map((s) => s.code);

test('content hashes ignore line-ending differences', () => {
  assert.equal(hashContent('a\r\nb\r\n'), hashContent('a\nb\n'));
  assert.notEqual(hashContent('a\nb\n'), hashContent('a\nB\n'));
});

test('evidence sources may carry anchors and line ranges', () => {
  assert.equal(evidenceFilePath('docs/architecture.md#section-3'), 'docs/architecture.md');
  assert.equal(evidenceFilePath('src/db.ts:12-40'), 'src/db.ts');
  assert.equal(evidenceFilePath('src/db.ts:7'), 'src/db.ts');
});

test('hashFile refuses paths outside the project', (t) => {
  const { root } = makeProject(t, { 'docs/a.md': 'x' });
  assert.ok(hashFile(root, 'docs/a.md'));
  assert.equal(hashFile(root, '../outside.md'), null);
  assert.equal(hashFile(root, 'docs'), null);
  assert.equal(hashFile(root, 'docs/missing.md'), null);
});

test('evidence state follows the file: verified → changed → missing', (t) => {
  const { root, ctx } = makeProject(t, { 'docs/architecture.md': '# v1\n' });
  const decision = recordDecision(ctx, MONGO, meta);
  const evidence = () => ctx.store.evidence.get(decision.evidence[0].id);
  assert.equal(resolveEvidence(root, evidence()).state, 'verified');
  write(root, 'docs/architecture.md', '# v2 — frontend may now query directly\n');
  assert.equal(resolveEvidence(root, evidence()).state, 'changed');
  fs.rmSync(path.join(root, 'docs/architecture.md'));
  assert.equal(resolveEvidence(root, evidence()).state, 'missing');
});

test('non-file evidence is reported as unverifiable rather than guessed', (t) => {
  const { root } = makeProject(t);
  assert.equal(resolveEvidence(root, { kind: 'url', source: 'https://example.com/adr' }).state, 'unverifiable');
  assert.equal(resolveEvidence(root, { kind: 'note', source: 'Agreed in review' }).state, 'unverifiable');
});

test('a healthy decision raises no drift signals', (t) => {
  const { ctx } = makeProject(t, { 'docs/architecture.md': '# v1\n', 'apps/web/page.js': "import { api } from './api';\n" });
  recordDecision(ctx, MONGO, meta);
  const result = reviewDecisions(ctx);
  assert.equal(result.reviewed, 1);
  assert.deepEqual(result.items, []);
});

test('changed and missing evidence are flagged', (t) => {
  const { root, ctx } = makeProject(t, { 'docs/architecture.md': '# v1\n', 'apps/web/page.js': 'x' });
  recordDecision(ctx, MONGO, meta);
  write(root, 'docs/architecture.md', '# v2\n');
  assert.deepEqual(signalsFor(reviewDecisions(ctx), 'DEC-0001'), ['evidence_changed']);
  fs.rmSync(path.join(root, 'docs/architecture.md'));
  assert.deepEqual(signalsFor(reviewDecisions(ctx), 'DEC-0001'), ['evidence_missing']);
});

test('keeping a decision re-verifies its evidence and clears the signal', (t) => {
  const { root, ctx } = makeProject(t, { 'docs/architecture.md': '# v1\n', 'apps/web/page.js': 'x' });
  recordDecision(ctx, MONGO, meta);
  write(root, 'docs/architecture.md', '# v2, still says the same thing\n');
  assert.deepEqual(reverifyEvidence(ctx, 'DEC-0001'), ['EVD-0001']);
  markReviewed(ctx, 'DEC-0001');
  assert.deepEqual(reviewDecisions(ctx).items, []);
});

test('code that already contradicts a constraint is the core drift signal', (t) => {
  const { ctx } = makeProject(t, {
    'docs/architecture.md': '# v1\n',
    'apps/web/legacy/report.js': "const { MongoClient } = require('mongodb');\n",
    'apps/web/page.js': "import { api } from './api';\n",
    'services/api/db.js': "import { MongoClient } from 'mongodb';\n", // out of scope: fine
  });
  recordDecision(ctx, MONGO, meta);
  const result = reviewDecisions(ctx);
  assert.deepEqual(signalsFor(result, 'DEC-0001'), ['violated_in_code']);
  const signal = result.items[0].signals[0];
  assert.deepEqual(signal.files, ['apps/web/legacy/report.js']);
  assert.equal(signal.constraintId, 'CON-0001');
  assert.equal(signal.level, 'high');
});

test('files covered by an exception are not counted as drift', (t) => {
  const { ctx } = makeProject(t, {
    'docs/architecture.md': '# v1\n',
    'apps/web/admin/users.js': "import { MongoClient } from 'mongodb';\n",
  });
  recordDecision(ctx, MONGO, meta);
  grantException(ctx, 'DEC-0001', { reason: 'Admin is server-rendered', scope: ['apps/web/admin/**'] });
  assert.deepEqual(signalsFor(reviewDecisions(ctx), 'DEC-0001'), []);
});

test('a scope that matches no file is flagged', (t) => {
  const { ctx } = makeProject(t, { 'src/index.js': 'x' });
  recordDecision(ctx, RABBIT, meta);
  assert.deepEqual(signalsFor(reviewDecisions(ctx), 'DEC-0001'), ['scope_empty']);
});

test('decisions go stale after the configured number of days', (t) => {
  const { ctx } = makeProject(t, { 'services/a.js': 'x' });
  recordDecision(ctx, RABBIT, meta);
  const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString();
  assert.deepEqual(signalsFor(reviewDecisions(ctx, { now: inDays(179) }), 'DEC-0001'), []);
  assert.deepEqual(signalsFor(reviewDecisions(ctx, { now: inDays(181) }), 'DEC-0001'), ['stale']);
  ctx.config.review.staleAfterDays = 30;
  assert.deepEqual(signalsFor(reviewDecisions(ctx, { now: inDays(31) }), 'DEC-0001'), ['stale']);
});

test('a decision that keeps causing conflicts or collecting exceptions is flagged', (t) => {
  const { ctx } = makeProject(t, { 'docs/architecture.md': 'x', 'apps/web/ok.js': 'x' });
  recordDecision(ctx, MONGO, meta);
  for (const session of ['s1', 's2', 's3']) {
    const result = evaluateFile(ctx, { path: 'apps/web/new.js', segments: [{ startLine: 1, text: "import m from 'mongoose'" }] });
    recordFindings(ctx, result.findings, { sessionId: session });
  }
  assert.deepEqual(signalsFor(reviewDecisions(ctx), 'DEC-0001'), ['repeated_conflicts']);

  grantException(ctx, 'DEC-0001', { reason: 'one', scope: ['apps/web/a/**'] });
  grantException(ctx, 'DEC-0001', { reason: 'two', scope: ['apps/web/b/**'] });
  assert.deepEqual(signalsFor(reviewDecisions(ctx), 'DEC-0001'), ['repeated_conflicts', 'many_exceptions']);
});

test('review also lists proposals awaiting confirmation and expired exceptions', (t) => {
  const { ctx } = makeProject(t, { 'services/a.js': 'x' });
  recordDecision(ctx, RABBIT, meta);
  recordDecision(ctx, { ...MONGO, source: 'claude' }, { actor: 'claude' });
  grantException(ctx, 'DEC-0001', { reason: 'Temporary', expires: '2020-01-01' });
  const result = reviewDecisions(ctx);
  assert.deepEqual(result.proposed.map((d) => d.id), ['DEC-0002']);
  assert.deepEqual(result.expiredExceptions.map((e) => e.id), ['EXC-0001']);
  assert.equal(result.reviewed, 1, 'only active decisions are examined');
});

test('the most serious drift is listed first', (t) => {
  const { ctx } = makeProject(t, { 'apps/web/db.js': "import m from 'mongodb'\n", 'docs/architecture.md': 'x', 'src/x.js': 'x' });
  recordDecision(ctx, RABBIT, meta); // scope_empty (medium)
  recordDecision(ctx, MONGO, meta); // violated_in_code (high)
  assert.deepEqual(reviewDecisions(ctx).items.map((item) => item.decision.id), ['DEC-0002', 'DEC-0001']);
});
