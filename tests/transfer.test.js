import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { evaluateFile } from '../src/core/conflict-engine.js';
import { deprecateDecision, getDecision, grantException, recordDecision, rejectAlternative, supersedeDecision } from '../src/core/decision-engine.js';
import { EXPORT_FORMAT, exportData, importData } from '../src/core/transfer.js';
import { GENERATED, MONGO, RABBIT, cli, makeProject, meta } from './helpers.js';

function populated(t) {
  const { root, ctx } = makeProject(t, { 'docs/architecture.md': '# Architecture\n' });
  recordDecision(ctx, MONGO, meta);
  recordDecision(ctx, { ...RABBIT, source: 'document' }, meta);
  recordDecision(ctx, { ...GENERATED, source: 'claude' }, { actor: 'claude' });
  grantException(ctx, 'DEC-0001', { reason: 'Admin is server-side', scope: ['apps/web/admin/**'], constraint: 'CON-0001' });
  rejectAlternative(ctx, { title: 'Redis for caching', reason: 'No Redis in our infrastructure' });
  supersedeDecision(ctx, 'DEC-0002', { title: 'HTTP between services', decision: 'Sync HTTP allowed.', reason: 'Broker incidents.' }, meta);
  return { root, ctx };
}

test('export produces a readable, versioned document', (t) => {
  const { ctx } = populated(t);
  const document = exportData(ctx);
  assert.equal(document.format, EXPORT_FORMAT);
  assert.deepEqual(document.decisions.map((d) => [d.id, d.status, d.source]), [
    ['DEC-0001', 'active', 'developer'],
    ['DEC-0002', 'superseded', 'document'],
    ['DEC-0003', 'proposed', 'claude'],
    ['DEC-0004', 'active', 'developer'],
  ]);
  const mongo = document.decisions[0];
  assert.equal(mongo.decision, MONGO.decision);
  assert.equal(mongo.reason, MONGO.reason);
  assert.equal(mongo.constraints[0].patterns.length, 2);
  assert.equal(mongo.evidence[0].source, 'docs/architecture.md');
  assert.equal(mongo.alternatives[0].title, 'Realm SDK in the browser');
  assert.equal(mongo.exceptions[0].constraintId, 'CON-0001');
  assert.equal(document.decisions[1].supersededBy, 'DEC-0004');
  assert.deepEqual(document.rejectedIdeas.map((idea) => idea.title), ['Redis for caching']);
  assert.equal(document.conflicts, undefined);
  assert.ok(Array.isArray(exportData(ctx, { full: true }).history));
});

test('import into an empty project reproduces decisions, status, provenance and links', (t) => {
  const source = populated(t);
  const target = makeProject(t, { 'docs/architecture.md': '# Architecture\n' });
  const report = importData(target.ctx, JSON.parse(JSON.stringify(exportData(source.ctx))));
  assert.deepEqual(report.imported, ['DEC-0001', 'DEC-0002', 'DEC-0003', 'DEC-0004']);
  assert.deepEqual(report.skipped, []);
  assert.equal(report.rejectedIdeas, 1);

  const mongo = getDecision(target.ctx, 'DEC-0001');
  assert.equal(mongo.status, 'active');
  assert.equal(mongo.constraints.length, 1);
  assert.ok(mongo.evidence[0].verifiedAt, 'evidence is re-verified against the importing checkout');
  assert.equal(mongo.exceptions[0].constraintId, mongo.constraints[0].id, 'exception is re-linked to the new constraint ID');
  assert.equal(getDecision(target.ctx, 'DEC-0002').supersededBy, 'DEC-0004');
  assert.equal(getDecision(target.ctx, 'DEC-0003').status, 'proposed', 'an unconfirmed proposal stays unconfirmed');
  assert.equal(getDecision(target.ctx, 'DEC-0003').source, 'claude');

  // behaviour carries over, exception included
  const text = "import { MongoClient } from 'mongodb';";
  assert.equal(evaluateFile(target.ctx, { path: 'apps/web/db.js', segments: [{ startLine: 1, text }] }).verdict, 'potential_conflict');
  assert.equal(evaluateFile(target.ctx, { path: 'apps/web/admin/db.js', segments: [{ startLine: 1, text }] }).findings.length, 0);

  // new IDs continue after the imported ones
  assert.equal(recordDecision(target.ctx, { title: 'New one', decision: 'd', reason: 'r' }, meta).id, 'DEC-0005');
});

test('importing twice changes nothing', (t) => {
  const source = populated(t);
  const target = makeProject(t);
  const document = exportData(source.ctx);
  importData(target.ctx, document);
  const second = importData(target.ctx, document);
  assert.deepEqual(second.imported, []);
  assert.equal(second.skipped.length, 4);
  assert.equal(second.rejectedIdeas, 0);
  assert.equal(target.ctx.store.decisions.list().length, 4);
});

test('import never overwrites an existing decision', (t) => {
  const source = makeProject(t);
  recordDecision(source.ctx, RABBIT, meta);
  const target = makeProject(t);
  recordDecision(target.ctx, MONGO, meta); // also DEC-0001, different content
  const report = importData(target.ctx, exportData(source.ctx));
  assert.deepEqual(report.skipped, [{ id: 'DEC-0001', reason: 'already exists' }]);
  assert.equal(getDecision(target.ctx, 'DEC-0001').title, MONGO.title);
});

test('hand-written documents work: IDs are optional and unknown status means proposed', (t) => {
  const { ctx } = makeProject(t);
  const report = importData(ctx, { decisions: [{ title: 'Use pnpm', decision: 'pnpm only', reason: 'Workspace support', status: 'whatever' }] });
  assert.deepEqual(report.imported, ['DEC-0001']);
  assert.equal(getDecision(ctx, 'DEC-0001').status, 'proposed');
});

test('import validates everything and is atomic', (t) => {
  const { ctx } = makeProject(t);
  assert.throws(() => importData(ctx, { nope: true }), /expected an object with a "decisions" array/);
  assert.throws(() => importData(ctx, { format: 'other/v9', decisions: [] }), /unsupported export format/);
  const document = {
    decisions: [
      { title: 'Good', decision: 'd', reason: 'r' },
      { title: 'Leaky', decision: 'd', reason: 'key AKIAIOSFODNN7EXAMPLE' },
    ],
  };
  assert.throws(() => importData(ctx, document), /AWS access key/);
  assert.equal(ctx.store.decisions.list().length, 0, 'nothing imported when any record is invalid');
});

test('export and import through the CLI', async (t) => {
  const source = populated(t);
  const exported = await cli(source.root, 'export');
  assert.match(exported.out, /Exported 4 decision\(s\) to .*decisions\.json/);
  const file = path.join(source.root, '.intentguard', 'decisions.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).decisions.length, 4);
  assert.equal(JSON.parse((await cli(source.root, 'export', '--stdout')).out).format, EXPORT_FORMAT);

  const target = makeProject(t);
  const imported = await cli(target.root, 'import', file);
  assert.match(imported.out, /Imported 4 decision\(s\): DEC-0001, DEC-0002, DEC-0003, DEC-0004/);
  assert.match(imported.out, /Imported 1 rejected idea/);
  assert.match((await cli(target.root, 'import', file)).out, /Skipped DEC-0001: already exists/);
  assert.match((await cli(target.root, 'history', 'DEC-0001')).out, /decision\.imported/);
});

test('deprecated decisions survive a round trip without blocking the title', (t) => {
  const source = makeProject(t);
  recordDecision(source.ctx, RABBIT, meta);
  deprecateDecision(source.ctx, 'DEC-0001');
  recordDecision(source.ctx, { ...RABBIT, reason: 'Second attempt' }, meta);
  const target = makeProject(t);
  const report = importData(target.ctx, exportData(source.ctx));
  assert.deepEqual(report.imported, ['DEC-0001', 'DEC-0002']);
});
