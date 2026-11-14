import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCommand, evaluateFile, recordFindings, verdictAtLeast, worstVerdict } from '../src/core/conflict-engine.js';
import { grantException, recordDecision, resolveConflict } from '../src/core/decision-engine.js';
import { GENERATED, MONGO, RABBIT, makeProject, meta } from './helpers.js';

const IMPORT = "import { MongoClient } from 'mongodb';";
const change = (path, text, startLine = 1) => ({ path, segments: [{ startLine, text }] });

test('verdict ordering', () => {
  assert.equal(worstVerdict([]), 'compatible');
  assert.equal(worstVerdict(['unknown', 'compatible']), 'unknown');
  assert.equal(worstVerdict(['potential_conflict', 'unknown', 'confirmed_violation']), 'confirmed_violation');
  assert.equal(verdictAtLeast('potential_conflict', 'unknown'), true);
  assert.equal(verdictAtLeast('unknown', 'potential_conflict'), false);
});

test('a detector match inside scope is a potential conflict, anchored to decision, line and excerpt', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const result = evaluateFile(ctx, change('apps/web/lib/db.js', `// data layer\nconst x = 1;\n  ${IMPORT}\n`, 10));
  assert.equal(result.verdict, 'potential_conflict');
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding.decisionId, 'DEC-0001');
  assert.equal(finding.constraintId, 'CON-0001');
  assert.equal(finding.line, 12);
  assert.equal(finding.excerpt, IMPORT);
  assert.equal(finding.detector, 'pattern');
  assert.equal(finding.confidence, 0.8);
  assert.equal(finding.enforcement, 'warn', 'inherits the project default');
  assert.match(finding.description, /apps\/web\/lib\/db\.js:12 matches/);
});

test('the same text outside the scope is compatible', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const result = evaluateFile(ctx, change('services/api/db.js', IMPORT));
  assert.equal(result.verdict, 'compatible');
  assert.deepEqual(result.governing, []);
});

test('in scope with clean detectors is compatible', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const result = evaluateFile(ctx, change('apps/web/page.js', "import { api } from './api';\n// mongodb is only reached through the backend"));
  assert.equal(result.verdict, 'compatible');
  assert.equal(result.governing.length, 1);
});

test('a governing decision without a mechanical detector yields unknown, never a silent pass', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  const result = evaluateFile(ctx, change('services/order/notify.js', "await fetch('http://notification/send')"));
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.findings.length, 0);
  assert.equal(result.governing[0].decision.id, 'DEC-0001');
});

test('a decision with no constraints at all still governs its scope', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, { ...RABBIT, constraints: [] }, meta);
  assert.equal(evaluateFile(ctx, change('services/a.js', 'x')).verdict, 'unknown');
});

test('modifying a protected path is a confirmed violation regardless of content', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, GENERATED, meta);
  const result = evaluateFile(ctx, change('src/generated/client.ts', '// harmless comment'));
  assert.equal(result.verdict, 'confirmed_violation');
  assert.equal(result.findings[0].detector, 'protect');
  assert.equal(result.findings[0].confidence, 1);
  assert.equal(evaluateFile(ctx, { path: 'src/generated/client.ts' }).verdict, 'confirmed_violation', 'even a deletion');
});

test('proposed, deprecated and superseded decisions are not enforced', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, { actor: 'claude' }); // proposed
  const result = evaluateFile(ctx, change('apps/web/db.js', IMPORT));
  assert.equal(result.verdict, 'compatible');
  assert.equal(result.findings.length, 0);
});

test('a constraint may narrow or move its own scope', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(
    ctx,
    {
      ...RABBIT,
      constraints: [{ rule: 'No axios in service code', patterns: ["from ['\"]axios['\"]"], scope: ['services/**', '!**/*.test.js'] }],
    },
    meta,
  );
  const code = "import axios from 'axios';";
  assert.equal(evaluateFile(ctx, change('services/order/client.js', code)).verdict, 'potential_conflict');
  // the decision still governs the test file, but the constraint is scoped away from it
  const inTest = evaluateFile(ctx, change('services/order/client.test.js', code));
  assert.equal(inTest.findings.length, 0);
  assert.equal(inTest.verdict, 'unknown');
});

test('an exception in force silences the constraint for its scope only', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  grantException(ctx, 'DEC-0001', { reason: 'Admin runs server-side', scope: ['apps/web/admin/**'] });
  const inside = evaluateFile(ctx, change('apps/web/admin/users.js', IMPORT));
  assert.equal(inside.findings.length, 0);
  assert.equal(inside.excepted[0].exception.id, 'EXC-0001');
  assert.equal(inside.verdict, 'compatible');
  assert.equal(evaluateFile(ctx, change('apps/web/shop/cart.js', IMPORT)).verdict, 'potential_conflict');
});

test('an expired exception no longer applies', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  grantException(ctx, 'DEC-0001', { reason: 'Temporary migration', scope: ['apps/web/**'], expires: '2020-01-01' });
  assert.equal(evaluateFile(ctx, change('apps/web/db.js', IMPORT)).verdict, 'potential_conflict');
});

test('enforcement comes from the constraint, else from project config', (t) => {
  const { ctx } = makeProject(t, {}, { enforcement: 'observe' });
  recordDecision(ctx, MONGO, meta);
  recordDecision(ctx, { ...GENERATED, constraints: [{ ...GENERATED.constraints[0], enforcement: 'enforce' }] }, meta);
  assert.equal(evaluateFile(ctx, change('apps/web/db.js', IMPORT)).findings[0].enforcement, 'observe');
  assert.equal(evaluateFile(ctx, change('src/generated/a.ts', 'x')).findings[0].enforcement, 'enforce');
});

test('only the first matching pattern is reported per constraint and file', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const result = evaluateFile(ctx, change('apps/web/db.js', `const a = require('mongoose');\n${IMPORT}\n${IMPORT}`));
  assert.equal(result.findings.length, 1);
});

test('edits without line information still produce a finding', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const result = evaluateFile(ctx, { path: 'apps/web/db.js', segments: [{ startLine: null, text: IMPORT }] });
  assert.equal(result.findings[0].line, null);
  assert.match(result.findings[0].description, /apps\/web\/db\.js matches/);
});

test('shell commands are checked against command patterns', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const hit = evaluateCommand(ctx, { command: 'cd apps/web && npm install mongodb --save' });
  assert.equal(hit.verdict, 'potential_conflict');
  assert.equal(hit.findings[0].detector, 'command');
  assert.equal(hit.findings[0].path, null);
  assert.equal(evaluateCommand(ctx, { command: 'npm install express' }).verdict, 'compatible');
  assert.equal(evaluateCommand(ctx, { command: 'npm test' }).findings.length, 0);
});

test('a corrupt stored pattern is skipped instead of breaking the check', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  ctx.store.q.run("UPDATE constraints SET patterns = ? WHERE id = 'CON-0001'", JSON.stringify(['(broken', "from ['\"]mongodb['\"]"]));
  const result = evaluateFile(ctx, change('apps/web/db.js', IMPORT));
  assert.equal(result.findings.length, 1);
});

test('the same conflict is one record however often it is seen', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const detect = (sessionId) => {
    const result = evaluateFile(ctx, change('apps/web/db.js', IMPORT));
    return recordFindings(ctx, result.findings, { sessionId, detectedBy: 'hook' })[0];
  };
  const first = detect('s1');
  assert.equal(first.conflictId, 'CONF-0001');
  assert.equal(first.isNew, true);
  const second = detect('s1');
  assert.equal(second.conflictId, 'CONF-0001');
  assert.equal(second.isNew, false);
  assert.equal(ctx.store.conflicts.list().length, 1);
  assert.equal(ctx.store.conflicts.get('CONF-0001').occurrences, 1, 'repeated edits in one session count once');
  detect('s2');
  assert.equal(ctx.store.conflicts.get('CONF-0001').occurrences, 2, 'a new session counts again');
  assert.equal(ctx.store.history.list({ action: 'conflict.detected' }).length, 1);
});

test('different files or patterns are different conflicts', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const a = evaluateFile(ctx, change('apps/web/a.js', IMPORT)).findings;
  const b = evaluateFile(ctx, change('apps/web/b.js', IMPORT)).findings;
  recordFindings(ctx, [...a, ...b]);
  assert.notEqual(a[0].fingerprint, b[0].fingerprint);
  assert.deepEqual(ctx.store.conflicts.list().map((c) => c.id), ['CONF-0001', 'CONF-0002']);
});

test('a dismissed false positive stays suppressed; a resolved conflict reopens if it comes back', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  const detect = () => recordFindings(ctx, evaluateFile(ctx, change('apps/web/db.js', IMPORT)).findings, { sessionId: 's' })[0];
  detect();
  resolveConflict(ctx, 'CONF-0001', 'false_positive', { note: 'Type-only import' });
  assert.equal(detect().suppressed, true);
  assert.equal(ctx.store.conflicts.get('CONF-0001').status, 'dismissed');

  resolveConflict(ctx, 'CONF-0001', 'kept', { note: 'Removed the import' });
  const back = detect();
  assert.equal(back.suppressed, false);
  const reopened = ctx.store.conflicts.get('CONF-0001');
  assert.equal(reopened.status, 'pending');
  assert.equal(reopened.resolution, null);
  assert.equal(reopened.resolvedAt, null);
});
