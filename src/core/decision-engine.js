/**
 * Decision engine: every write to the decision store goes through here, so
 * validation, provenance and the audit trail are applied consistently.
 *
 * Guiding rule: IntentGuard never decides on the developer's behalf. Anything
 * not explicitly confirmed is stored as `proposed` and is not enforced.
 */
import { canonicalId } from '../storage/store.js';
import { isInForce } from '../storage/repositories/exceptions.js';
import { nowIso } from '../storage/repositories/util.js';
import { stampEvidence } from './evidence-resolver.js';
import { deriveKeywords } from './relevance.js';
import {
  NotFoundError,
  RESOLUTIONS,
  ValidationError,
  validateAlternativeInput,
  validateConstraintInput,
  validateDecisionInput,
  validateEnum,
  validateEvidenceInput,
  validateExceptionInput,
} from './validation.js';

const TRACKED_FIELDS = ['title', 'statement', 'rationale', 'type', 'scope', 'keywords'];

const snapshot = (decision) => Object.fromEntries(TRACKED_FIELDS.map((field) => [field, decision[field]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const actorOf = (meta) => meta.actor ?? 'developer';

/** Fetch a decision by (loosely formatted) ID or throw. */
export function requireDecision(ctx, id) {
  const canonical = canonicalId(id, 'DEC');
  const decision = canonical && ctx.store.decisions.get(canonical);
  if (!decision) throw new NotFoundError('Decision', id);
  return decision;
}

/** A decision with everything attached to it. */
export function getDecision(ctx, id) {
  const decision = requireDecision(ctx, id);
  const now = nowIso();
  const exceptions = ctx.store.exceptions.listByDecision(decision.id);
  return {
    ...decision,
    constraints: ctx.store.constraints.listByDecision(decision.id),
    evidence: ctx.store.evidence.listByDecision(decision.id),
    alternatives: ctx.store.alternatives.listByDecision(decision.id),
    exceptions: exceptions.map((exception) => ({ ...exception, inForce: isInForce(exception, now) })),
    conflicts: ctx.store.conflicts.list({ decisionId: decision.id, status: 'pending' }),
  };
}

function insertConstraint(ctx, decision, data, meta, ts) {
  const constraint = { id: ctx.store.nextId('CON'), decisionId: decision.id, ...data, createdAt: ts, updatedAt: ts };
  ctx.store.constraints.insert(constraint);
  ctx.store.history.record({
    entityType: 'constraint',
    entityId: constraint.id,
    decisionId: decision.id,
    action: 'constraint.added',
    actor: actorOf(meta),
    sessionId: meta.sessionId,
    summary: `${data.kind === 'must' ? 'MUST' : 'MUST NOT'}: ${data.rule}`,
    createdAt: ts,
  });
  return constraint;
}

function insertEvidence(ctx, decision, data, meta, ts) {
  const stamp = stampEvidence(ctx.root, data, ts);
  const evidence = { id: ctx.store.nextId('EVD'), decisionId: decision.id, ...data, ...stamp, createdAt: ts };
  ctx.store.evidence.insert(evidence);
  ctx.store.history.record({
    entityType: 'evidence',
    entityId: evidence.id,
    decisionId: decision.id,
    action: 'evidence.added',
    actor: actorOf(meta),
    sessionId: meta.sessionId,
    summary: `${data.kind}: ${data.source}${data.locator ? ` (${data.locator})` : ''}`,
    createdAt: ts,
  });
  return evidence;
}

function insertAlternative(ctx, decisionId, data, meta, ts) {
  const alternative = {
    id: ctx.store.nextId('ALT'),
    decisionId,
    ...data,
    keywords: data.keywords.length ? data.keywords : deriveKeywords(data.title),
    status: 'rejected',
    createdAt: ts,
    updatedAt: ts,
  };
  ctx.store.alternatives.insert(alternative);
  ctx.store.history.record({
    entityType: 'alternative',
    entityId: alternative.id,
    decisionId,
    action: 'alternative.rejected',
    actor: actorOf(meta),
    sessionId: meta.sessionId,
    summary: `Rejected: ${data.title} — ${data.reason}`,
    createdAt: ts,
  });
  return alternative;
}

/**
 * Record a decision (with nested constraints, evidence and rejected alternatives).
 * It becomes `active` only when `meta.confirmed` is true, i.e. the developer
 * explicitly approved it; otherwise it is stored as `proposed`.
 */
export function recordDecision(ctx, input, meta = {}) {
  const data = validateDecisionInput(input);
  return ctx.store.tx(() => {
    const duplicate = ctx.store.decisions.findByTitle(data.title);
    if (duplicate) {
      throw new ValidationError(
        `a decision titled "${data.title}" already exists (${duplicate.id}, ${duplicate.status}). Update or supersede it instead of recording it twice.`,
      );
    }
    const ts = nowIso();
    const confirmed = meta.confirmed === true;
    const decision = {
      id: ctx.store.nextId('DEC'),
      title: data.title,
      statement: data.statement,
      rationale: data.rationale,
      type: data.type,
      status: confirmed ? 'active' : 'proposed',
      source: data.source,
      scope: data.scope,
      keywords: data.keywords.length ? data.keywords : deriveKeywords(data.title),
      revision: 1,
      confirmedAt: confirmed ? ts : null,
      createdAt: ts,
      updatedAt: ts,
    };
    ctx.store.decisions.insert(decision);
    ctx.store.history.record({
      entityType: 'decision',
      entityId: decision.id,
      decisionId: decision.id,
      action: 'decision.created',
      actor: actorOf(meta),
      sessionId: meta.sessionId,
      summary: `${confirmed ? 'Recorded' : 'Proposed'}: ${decision.title} (source: ${decision.source})`,
      changes: { after: snapshot(decision) },
      createdAt: ts,
    });
    for (const constraint of data.constraints) insertConstraint(ctx, decision, constraint, meta, ts);
    for (const evidence of data.evidence) insertEvidence(ctx, decision, evidence, meta, ts);
    for (const alternative of data.alternatives) insertAlternative(ctx, decision.id, alternative, meta, ts);
    return getDecision(ctx, decision.id);
  });
}

/** The developer approves a proposed decision; it becomes active. */
export function confirmDecision(ctx, id, meta = {}) {
  return ctx.store.tx(() => {
    const decision = requireDecision(ctx, id);
    if (decision.status === 'active') return getDecision(ctx, decision.id);
    if (decision.status !== 'proposed') {
      throw new ValidationError(`${decision.id} is ${decision.status}; only proposed decisions can be confirmed (use reactivate).`);
    }
    const ts = nowIso();
    ctx.store.decisions.update(decision.id, { status: 'active', confirmedAt: ts, updatedAt: ts });
    ctx.store.history.record({
      entityType: 'decision',
      entityId: decision.id,
      decisionId: decision.id,
      action: 'decision.confirmed',
      actor: actorOf(meta),
      sessionId: meta.sessionId,
      summary: meta.note || 'Confirmed by the developer',
      createdAt: ts,
    });
    return getDecision(ctx, decision.id);
  });
}

/** Edit a decision in place. Bumps the revision and records a before/after diff. */
export function updateDecision(ctx, id, patch, meta = {}) {
  const data = validateDecisionInput(patch, { partial: true });
  return ctx.store.tx(() => {
    const decision = requireDecision(ctx, id);
    const ts = nowIso();
    const before = {};
    const after = {};
    for (const field of TRACKED_FIELDS) {
      if (data[field] !== undefined && !same(data[field], decision[field])) {
        before[field] = decision[field];
        after[field] = data[field];
      }
    }
    const additions = (data.constraints?.length ?? 0) + (data.evidence?.length ?? 0) + (data.alternatives?.length ?? 0);
    if (!Object.keys(after).length && !additions) return getDecision(ctx, decision.id);

    if (Object.keys(after).length) {
      if (after.title) {
        const duplicate = ctx.store.decisions.findByTitle(after.title);
        if (duplicate && duplicate.id !== decision.id) {
          throw new ValidationError(`a decision titled "${after.title}" already exists (${duplicate.id}).`);
        }
      }
      ctx.store.decisions.update(decision.id, { ...after, revision: decision.revision + 1, updatedAt: ts });
      ctx.store.history.record({
        entityType: 'decision',
        entityId: decision.id,
        decisionId: decision.id,
        action: 'decision.updated',
        actor: actorOf(meta),
        sessionId: meta.sessionId,
        summary: meta.note || `Changed ${Object.keys(after).join(', ')} (revision ${decision.revision + 1})`,
        changes: { before, after },
        createdAt: ts,
      });
    }
    for (const constraint of data.constraints ?? []) insertConstraint(ctx, decision, constraint, meta, ts);
    for (const evidence of data.evidence ?? []) insertEvidence(ctx, decision, evidence, meta, ts);
    for (const alternative of data.alternatives ?? []) insertAlternative(ctx, decision.id, alternative, meta, ts);
    return getDecision(ctx, decision.id);
  });
}

function changeStatus(ctx, decision, status, action, meta, extra = {}) {
  const ts = nowIso();
  ctx.store.decisions.update(decision.id, { status, updatedAt: ts, ...extra });
  ctx.store.history.record({
    entityType: 'decision',
    entityId: decision.id,
    decisionId: decision.id,
    action,
    actor: actorOf(meta),
    sessionId: meta.sessionId,
    summary: meta.note || `${decision.status} → ${status}`,
    changes: { before: { status: decision.status }, after: { status } },
    createdAt: ts,
  });
}

function closePendingConflicts(ctx, decisionId, note, ts) {
  for (const conflict of ctx.store.conflicts.list({ decisionId, status: 'pending' })) {
    ctx.store.conflicts.update(conflict.id, { status: 'resolved', resolution: 'decision_updated', note, resolvedAt: ts });
  }
}

/** Retire a decision that no longer applies. It stays in history but is no longer checked. */
export function deprecateDecision(ctx, id, meta = {}) {
  return ctx.store.tx(() => {
    const decision = requireDecision(ctx, id);
    if (decision.status === 'deprecated') return getDecision(ctx, decision.id);
    changeStatus(ctx, decision, 'deprecated', 'decision.deprecated', meta);
    closePendingConflicts(ctx, decision.id, 'Decision deprecated', nowIso());
    return getDecision(ctx, decision.id);
  });
}

export function reactivateDecision(ctx, id, meta = {}) {
  return ctx.store.tx(() => {
    const decision = requireDecision(ctx, id);
    if (decision.status === 'active') return getDecision(ctx, decision.id);
    if (decision.status === 'proposed') throw new ValidationError(`${decision.id} is proposed; confirm it instead.`);
    changeStatus(ctx, decision, 'active', 'decision.reactivated', meta, { supersededBy: null });
    return getDecision(ctx, decision.id);
  });
}

/**
 * Replace a decision with a new one. The old record is kept, marked
 * `superseded`, and linked to its successor — changing course is allowed, but
 * it is always a visible, deliberate act.
 */
export function supersedeDecision(ctx, id, input, meta = {}) {
  return ctx.store.tx(() => {
    const previous = requireDecision(ctx, id);
    if (previous.status === 'superseded') {
      throw new ValidationError(`${previous.id} was already superseded by ${previous.supersededBy}.`);
    }
    // Free the title first so the successor may reuse it.
    changeStatus(ctx, previous, 'superseded', 'decision.superseded', {
      ...meta,
      note: meta.note || 'Superseded by a new decision',
    });
    const next = recordDecision(ctx, input, meta);
    const ts = nowIso();
    ctx.store.decisions.update(previous.id, { supersededBy: next.id, updatedAt: ts });
    ctx.store.history.record({
      entityType: 'decision',
      entityId: next.id,
      decisionId: next.id,
      action: 'decision.supersedes',
      actor: actorOf(meta),
      sessionId: meta.sessionId,
      summary: `Supersedes ${previous.id}: ${previous.title}`,
      createdAt: ts,
    });
    closePendingConflicts(ctx, previous.id, `Decision superseded by ${next.id}`, ts);
    return { previous: getDecision(ctx, previous.id), next: getDecision(ctx, next.id) };
  });
}

/** Mark a decision as reviewed and still valid (resets staleness). */
export function markReviewed(ctx, id, meta = {}) {
  return ctx.store.tx(() => {
    const decision = requireDecision(ctx, id);
    const ts = nowIso();
    ctx.store.decisions.update(decision.id, { reviewedAt: ts, updatedAt: ts });
    ctx.store.history.record({
      entityType: 'decision',
      entityId: decision.id,
      decisionId: decision.id,
      action: 'decision.reviewed',
      actor: actorOf(meta),
      sessionId: meta.sessionId,
      summary: meta.note || 'Reviewed and kept',
      createdAt: ts,
    });
    return getDecision(ctx, decision.id);
  });
}

export function addConstraint(ctx, decisionId, input, meta = {}) {
  const data = validateConstraintInput(input);
  return ctx.store.tx(() => insertConstraint(ctx, requireDecision(ctx, decisionId), data, meta, nowIso()));
}

export function removeConstraint(ctx, constraintId, meta = {}) {
  return ctx.store.tx(() => {
    const id = canonicalId(constraintId, 'CON');
    const constraint = id && ctx.store.constraints.get(id);
    if (!constraint) throw new NotFoundError('Constraint', constraintId);
    ctx.store.constraints.remove(constraint.id);
    ctx.store.history.record({
      entityType: 'constraint',
      entityId: constraint.id,
      decisionId: constraint.decisionId,
      action: 'constraint.removed',
      actor: actorOf(meta),
      sessionId: meta.sessionId,
      summary: meta.note || `Removed: ${constraint.rule}`,
      changes: { before: constraint },
    });
    return constraint;
  });
}

export function addEvidence(ctx, decisionId, input, meta = {}) {
  const data = validateEvidenceInput(input);
  return ctx.store.tx(() => insertEvidence(ctx, requireDecision(ctx, decisionId), data, meta, nowIso()));
}

/**
 * Re-verify evidence against the current state of the project: the developer
 * has looked at the changed source and the decision still stands.
 */
export function reverifyEvidence(ctx, decisionId, meta = {}) {
  return ctx.store.tx(() => {
    const decision = requireDecision(ctx, decisionId);
    const ts = nowIso();
    const updated = [];
    for (const evidence of ctx.store.evidence.listByDecision(decision.id)) {
      const stamp = stampEvidence(ctx.root, evidence, ts);
      if (!stamp.verifiedAt) continue;
      ctx.store.evidence.stamp(evidence.id, stamp.contentHash, stamp.verifiedAt);
      updated.push(evidence.id);
    }
    if (updated.length) {
      ctx.store.history.record({
        entityType: 'decision',
        entityId: decision.id,
        decisionId: decision.id,
        action: 'evidence.verified',
        actor: actorOf(meta),
        sessionId: meta.sessionId,
        summary: `Re-verified ${updated.join(', ')}`,
        createdAt: ts,
      });
    }
    return updated;
  });
}

/** Remember an idea that was considered and rejected, optionally tied to a decision. */
export function rejectAlternative(ctx, input, meta = {}) {
  const data = validateAlternativeInput(input);
  return ctx.store.tx(() => {
    const decisionId = meta.decisionId ? requireDecision(ctx, meta.decisionId).id : null;
    return insertAlternative(ctx, decisionId, data, meta, nowIso());
  });
}

/** Grant an explicit, explained exception to a decision. */
export function grantException(ctx, decisionId, input, meta = {}) {
  const data = validateExceptionInput(input);
  return ctx.store.tx(() => {
    const decision = requireDecision(ctx, decisionId);
    let constraintId = null;
    if (data.constraintId) {
      constraintId = canonicalId(data.constraintId, 'CON');
      const constraint = constraintId && ctx.store.constraints.get(constraintId);
      if (!constraint || constraint.decisionId !== decision.id) {
        throw new ValidationError(`constraint ${data.constraintId} does not belong to ${decision.id}`);
      }
    }
    const ts = nowIso();
    const exception = {
      id: ctx.store.nextId('EXC'),
      decisionId: decision.id,
      constraintId,
      scope: data.scope,
      reason: data.reason,
      approvedBy: data.approvedBy,
      expiresAt: data.expiresAt,
      createdAt: ts,
    };
    ctx.store.exceptions.insert(exception);
    ctx.store.history.record({
      entityType: 'exception',
      entityId: exception.id,
      decisionId: decision.id,
      action: 'exception.granted',
      actor: actorOf(meta),
      sessionId: meta.sessionId,
      summary: `Exception${data.scope.length ? ` for ${data.scope.join(', ')}` : ''}: ${data.reason}`,
      changes: { after: exception },
      createdAt: ts,
    });
    return ctx.store.exceptions.get(exception.id);
  });
}

export function revokeException(ctx, exceptionId, meta = {}) {
  return ctx.store.tx(() => {
    const id = canonicalId(exceptionId, 'EXC');
    const exception = id && ctx.store.exceptions.get(id);
    if (!exception) throw new NotFoundError('Exception', exceptionId);
    if (exception.revokedAt) return exception;
    const ts = nowIso();
    ctx.store.exceptions.revoke(exception.id, ts);
    ctx.store.history.record({
      entityType: 'exception',
      entityId: exception.id,
      decisionId: exception.decisionId,
      action: 'exception.revoked',
      actor: actorOf(meta),
      sessionId: meta.sessionId,
      summary: meta.note || 'Exception revoked',
      createdAt: ts,
    });
    return ctx.store.exceptions.get(exception.id);
  });
}

/**
 * Close a conflict with the developer's choice:
 *   kept               keep the decision; the change was adjusted
 *   decision_updated   the decision itself was changed/superseded
 *   exception_granted  allow it here, explicitly (creates an exception)
 *   false_positive     the detector was wrong; never warn about this again
 */
export function resolveConflict(ctx, conflictId, resolution, meta = {}) {
  const outcome = validateEnum(resolution, RESOLUTIONS, 'resolution');
  return ctx.store.tx(() => {
    const id = canonicalId(conflictId, 'CONF');
    const conflict = id && ctx.store.conflicts.get(id);
    if (!conflict) throw new NotFoundError('Conflict', conflictId);
    const ts = nowIso();
    let exception = null;
    if (outcome === 'exception_granted') {
      exception = grantException(
        ctx,
        conflict.decisionId,
        {
          reason: meta.note,
          scope: meta.scope ?? (conflict.filePath ? [conflict.filePath] : []),
          constraintId: conflict.constraintId,
          expires: meta.expires,
        },
        meta,
      );
    }
    ctx.store.conflicts.update(conflict.id, {
      status: outcome === 'false_positive' ? 'dismissed' : 'resolved',
      resolution: outcome,
      note: meta.note ?? '',
      resolvedAt: ts,
    });
    ctx.store.history.record({
      entityType: 'conflict',
      entityId: conflict.id,
      decisionId: conflict.decisionId,
      action: 'conflict.resolved',
      actor: actorOf(meta),
      sessionId: meta.sessionId,
      summary: `${conflict.id} resolved as ${outcome}${meta.note ? `: ${meta.note}` : ''}`,
      createdAt: ts,
    });
    return { conflict: ctx.store.conflicts.get(conflict.id), exception };
  });
}
