import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addConstraint,
  addEvidence,
  confirmDecision,
  deprecateDecision,
  getDecision,
  grantException,
  markReviewed,
  reactivateDecision,
  recordDecision,
  rejectAlternative,
  removeConstraint,
  requireDecision,
  resolveConflict,
  revokeException,
  supersedeDecision,
  updateDecision,
} from '../src/core/decision-engine.js';
import { evaluateFile, recordFindings } from '../src/core/conflict-engine.js';
import { NotFoundError, ValidationError } from '../src/core/validation.js';
import { MONGO, RABBIT, makeProject, meta } from './helpers.js';

const actions = (ctx, decisionId) => ctx.store.history.list({ decisionId }).map((entry) => entry.action).reverse();

test('an unconfirmed decision is stored as proposed and is not active', (t) => {
  const { ctx } = makeProject(t);
  const decision = recordDecision(ctx, { ...RABBIT, source: 'claude' }, { actor: 'claude' });
  assert.equal(decision.id, 'DEC-0001');
  assert.equal(decision.status, 'proposed');
  assert.equal(decision.confirmedAt, null);
  assert.equal(decision.source, 'claude');
  assert.equal(ctx.store.decisions.list({ status: 'active' }).length, 0);
});

test('a confirmed decision is active and stamped', (t) => {
  const { ctx } = makeProject(t);
  const decision = recordDecision(ctx, RABBIT, meta);
  assert.equal(decision.status, 'active');
  assert.ok(decision.confirmedAt);
  assert.equal(decision.revision, 1);
});

test('nested constraints, evidence and rejected alternatives are created with their own IDs', (t) => {
  const { ctx } = makeProject(t, { 'docs/architecture.md': '# Architecture\n' });
  const decision = recordDecision(ctx, MONGO, meta);
  assert.deepEqual(decision.constraints.map((c) => c.id), ['CON-0001']);
  assert.equal(decision.constraints[0].decisionId, 'DEC-0001');
  assert.equal(decision.constraints[0].patterns.length, 2);
  assert.deepEqual(decision.evidence.map((e) => [e.id, e.kind, e.source]), [['EVD-0001', 'file', 'docs/architecture.md']]);
  assert.ok(decision.evidence[0].contentHash, 'existing evidence file is hashed');
  assert.ok(decision.evidence[0].verifiedAt);
  assert.deepEqual(decision.alternatives.map((a) => [a.id, a.title]), [['ALT-0001', 'Realm SDK in the browser']]);
  assert.deepEqual(actions(ctx, 'DEC-0001'), ['decision.created', 'constraint.added', 'evidence.added', 'alternative.rejected']);
});

test('evidence pointing at a missing file is kept but not marked verified', (t) => {
  const { ctx } = makeProject(t);
  const decision = recordDecision(ctx, MONGO, meta);
  assert.equal(decision.evidence[0].contentHash, null);
  assert.equal(decision.evidence[0].verifiedAt, null);
});

test('keywords are derived from the title when none are given', (t) => {
  const { ctx } = makeProject(t);
  assert.deepEqual(recordDecision(ctx, RABBIT, meta).keywords, ['rabbitmq', 'async', 'communication']);
  assert.deepEqual(recordDecision(ctx, { ...MONGO, keywords: ['Mongo', 'frontend'] }, meta).keywords, ['mongo', 'frontend']);
});

test('recording the same title twice is refused', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  assert.throws(() => recordDecision(ctx, { ...RABBIT, title: 'use rabbitmq for ASYNC communication' }, meta), /already exists \(DEC-0001, active\)/);
  assert.equal(ctx.store.decisions.list().length, 1);
});

test('a failed record leaves nothing behind (atomic)', (t) => {
  const { ctx } = makeProject(t);
  assert.throws(() => recordDecision(ctx, { ...RABBIT, constraints: [{ rule: 'ok' }, { rule: '' }] }, meta), ValidationError);
  assert.equal(ctx.store.decisions.list().length, 0);
  assert.equal(ctx.store.history.list().length, 0);
  assert.equal(recordDecision(ctx, RABBIT, meta).id, 'DEC-0001', 'no ID was burned');
});

test('IDs are accepted in loose forms', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  for (const id of ['DEC-0001', 'dec-1', 'DEC1', ' dec-0001 ']) assert.equal(requireDecision(ctx, id).id, 'DEC-0001');
  assert.throws(() => requireDecision(ctx, 'DEC-0099'), NotFoundError);
  assert.throws(() => requireDecision(ctx, 'CON-0001'), NotFoundError);
  assert.throws(() => requireDecision(ctx, 'rabbit'), NotFoundError);
});

test('confirm turns a proposal into an active decision', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, { actor: 'claude' });
  const confirmed = confirmDecision(ctx, 'DEC-0001');
  assert.equal(confirmed.status, 'active');
  assert.ok(confirmed.confirmedAt);
  assert.deepEqual(actions(ctx, 'DEC-0001').slice(-1), ['decision.confirmed']);
  assert.equal(confirmDecision(ctx, 'DEC-0001').status, 'active', 'confirming twice is harmless');
});

test('update bumps the revision and records a before/after diff', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  const updated = updateDecision(ctx, 'DEC-0001', { reason: 'Failure isolation.', scope: ['services/**', 'workers/**'] }, { note: 'Workers joined' });
  assert.equal(updated.revision, 2);
  assert.equal(updated.rationale, 'Failure isolation.');
  assert.deepEqual(updated.scope, ['services/**', 'workers/**']);
  const entry = ctx.store.history.list({ decisionId: 'DEC-0001', action: 'decision.updated' })[0];
  assert.equal(entry.summary, 'Workers joined');
  assert.deepEqual(entry.changes.before, { rationale: RABBIT.reason, scope: ['services/**'] });
  assert.deepEqual(entry.changes.after, { rationale: 'Failure isolation.', scope: ['services/**', 'workers/**'] });
});

test('an update that changes nothing is a no-op', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  const same = updateDecision(ctx, 'DEC-0001', { reason: RABBIT.reason });
  assert.equal(same.revision, 1);
  assert.equal(ctx.store.history.list({ action: 'decision.updated' }).length, 0);
});

test('supersede keeps the old decision in history and links it to its successor', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  const { previous, next } = supersedeDecision(
    ctx,
    'DEC-0001',
    {
      title: 'Services may call each other over HTTP',
      decision: 'Synchronous HTTP is allowed between services.',
      reason: 'The broker became the main source of incidents.',
      scope: ['services/**'],
      alternatives: [{ title: 'RabbitMQ for everything', reason: 'Operational burden outweighed decoupling' }],
    },
    meta,
  );
  assert.equal(previous.status, 'superseded');
  assert.equal(previous.supersededBy, 'DEC-0002');
  assert.equal(next.status, 'active');
  assert.deepEqual(ctx.store.decisions.list({ status: 'active' }).map((d) => d.id), ['DEC-0002']);
  assert.ok(actions(ctx, 'DEC-0001').includes('decision.superseded'));
  assert.ok(actions(ctx, 'DEC-0002').includes('decision.supersedes'));
  assert.throws(() => supersedeDecision(ctx, 'DEC-0001', RABBIT, meta), /already superseded by DEC-0002/);
});

test('a superseding decision may reuse the old title, and a failed supersede rolls back', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  assert.throws(() => supersedeDecision(ctx, 'DEC-0001', { title: 'x' }, meta), ValidationError);
  assert.equal(getDecision(ctx, 'DEC-0001').status, 'active', 'rollback restored the original');
  const { next } = supersedeDecision(ctx, 'DEC-0001', { ...RABBIT, reason: 'Re-affirmed with a new reason.' }, meta);
  assert.equal(next.title, RABBIT.title);
});

test('deprecate and reactivate', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  assert.equal(deprecateDecision(ctx, 'DEC-0001', { note: 'Monolith now' }).status, 'deprecated');
  assert.equal(ctx.store.constraints.listActive().length, 0, 'constraints of a deprecated decision are not checked');
  assert.equal(reactivateDecision(ctx, 'DEC-0001').status, 'active');
  assert.equal(ctx.store.constraints.listActive().length, 1);
});

test('constraints and evidence can be added and removed later', (t) => {
  const { ctx } = makeProject(t, { 'docs/adr/001.md': 'ADR\n' });
  recordDecision(ctx, RABBIT, meta);
  const constraint = addConstraint(ctx, 'DEC-0001', { rule: 'No axios between services', patterns: ["from ['\"]axios['\"]"], enforcement: 'enforce' });
  assert.equal(constraint.id, 'CON-0002');
  assert.equal(constraint.enforcement, 'enforce');
  const evidence = addEvidence(ctx, 'DEC-0001', { source: 'docs/adr/001.md' });
  assert.equal(evidence.kind, 'file');
  assert.ok(evidence.verifiedAt);
  removeConstraint(ctx, 'con-2');
  assert.deepEqual(getDecision(ctx, 'DEC-0001').constraints.map((c) => c.id), ['CON-0001']);
  assert.throws(() => removeConstraint(ctx, 'CON-0099'), NotFoundError);
});

test('a rejected idea can stand alone or belong to a decision', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  const standalone = rejectAlternative(ctx, { title: 'Redis for session storage', reason: 'Ops will not run another stateful service' });
  assert.equal(standalone.decisionId, null);
  assert.deepEqual(standalone.keywords, ['redis', 'session', 'storage']);
  const attached = rejectAlternative(ctx, { title: 'Kafka', reason: 'Overkill at our volume' }, { decisionId: 'dec-1' });
  assert.equal(attached.decisionId, 'DEC-0001');
  assert.equal(ctx.store.alternatives.list({ status: 'rejected' }).length, 2);
});

test('exceptions are explicit, scoped, and revocable', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, MONGO, meta);
  recordDecision(ctx, RABBIT, meta);
  assert.throws(() => grantException(ctx, 'DEC-0001', {}), /conscious, explained choice/);
  assert.throws(() => grantException(ctx, 'DEC-0001', { reason: 'r', constraint: 'CON-0002' }), /does not belong to DEC-0001/);
  const exception = grantException(ctx, 'DEC-0001', { reason: 'Admin tool runs server-side', scope: ['apps/web/admin/**'], constraint: 'con-1' });
  assert.equal(exception.id, 'EXC-0001');
  assert.equal(exception.constraintId, 'CON-0001');
  assert.equal(getDecision(ctx, 'DEC-0001').exceptions[0].inForce, true);
  const revoked = revokeException(ctx, 'EXC-0001');
  assert.ok(revoked.revokedAt);
  assert.equal(getDecision(ctx, 'DEC-0001').exceptions[0].inForce, false);
});

function seedConflict(ctx) {
  recordDecision(ctx, MONGO, meta);
  const result = evaluateFile(ctx, { path: 'apps/web/db.js', segments: [{ startLine: 1, text: "import { MongoClient } from 'mongodb';" }] });
  recordFindings(ctx, result.findings, { detectedBy: 'check' });
  return result.findings[0].conflictId;
}

test('resolving a conflict as kept, updated or false positive', (t) => {
  const { ctx } = makeProject(t);
  const id = seedConflict(ctx);
  assert.equal(id, 'CONF-0001');
  assert.equal(resolveConflict(ctx, id, 'kept', { note: 'Will use the API' }).conflict.status, 'resolved');
  assert.equal(resolveConflict(ctx, id, 'false_positive', { note: 'Type import only' }).conflict.status, 'dismissed');
  assert.equal(resolveConflict(ctx, id, 'decision_updated').conflict.resolution, 'decision_updated');
  assert.throws(() => resolveConflict(ctx, id, 'whatever'), /resolution must be one of/);
  assert.throws(() => resolveConflict(ctx, 'CONF-0099', 'kept'), NotFoundError);
});

test('resolving as an exception records the exception against the offending file', (t) => {
  const { ctx } = makeProject(t);
  const id = seedConflict(ctx);
  assert.throws(() => resolveConflict(ctx, id, 'exception_granted', {}), /conscious, explained choice/);
  const { conflict, exception } = resolveConflict(ctx, id, 'exception_granted', { note: 'Seed script, runs in CI only' });
  assert.equal(conflict.resolution, 'exception_granted');
  assert.deepEqual(exception.scope, ['apps/web/db.js']);
  assert.equal(exception.constraintId, 'CON-0001');
  const again = evaluateFile(ctx, { path: 'apps/web/db.js', segments: [{ startLine: 1, text: "import { MongoClient } from 'mongodb';" }] });
  assert.equal(again.findings.length, 0);
  assert.equal(again.excepted.length, 1);
});

test('superseding or deprecating a decision closes its pending conflicts', (t) => {
  const { ctx } = makeProject(t);
  const id = seedConflict(ctx);
  deprecateDecision(ctx, 'DEC-0001', { note: 'Frontend is server-rendered now' });
  const conflict = ctx.store.conflicts.get(id);
  assert.equal(conflict.status, 'resolved');
  assert.equal(conflict.resolution, 'decision_updated');
});

test('markReviewed stamps the decision', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  assert.equal(getDecision(ctx, 'DEC-0001').reviewedAt, null);
  assert.ok(markReviewed(ctx, 'DEC-0001').reviewedAt);
});

test('history records who did what, newest first', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, { ...RABBIT, source: 'claude' }, { actor: 'claude', sessionId: 'sess-1' });
  confirmDecision(ctx, 'DEC-0001', { actor: 'developer' });
  const entries = ctx.store.history.list({ decisionId: 'DEC-0001' });
  assert.equal(entries[0].action, 'decision.confirmed');
  assert.equal(entries[0].actor, 'developer');
  const created = entries.find((entry) => entry.action === 'decision.created');
  assert.equal(created.actor, 'claude');
  assert.equal(created.sessionId, 'sess-1');
  assert.match(created.summary, /Proposed: .* \(source: claude\)/);
  assert.equal(created.changes.after.title, RABBIT.title);
});
