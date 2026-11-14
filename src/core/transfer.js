/**
 * Export / import in a plain JSON format, so decisions can be reviewed in pull
 * requests, shared with a team, or moved to another tool. Your data is yours.
 */
import { canonicalId } from '../storage/store.js';
import { nowIso } from '../storage/repositories/util.js';
import { stampEvidence } from './evidence-resolver.js';
import { deriveKeywords } from './relevance.js';
import {
  DECISION_STATUSES,
  ValidationError,
  validateAlternativeInput,
  validateDecisionInput,
  validateExceptionInput,
} from './validation.js';

export const EXPORT_FORMAT = 'intentguard/v1';

const validDate = (value, fallback) => (value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : fallback);

/** Build the export document. `full` also includes conflicts and the audit trail. */
export function exportData(ctx, options = {}) {
  const { store } = ctx;
  const decisions = store.decisions.list().map((decision) => ({
    id: decision.id,
    title: decision.title,
    decision: decision.statement,
    reason: decision.rationale,
    type: decision.type,
    status: decision.status,
    source: decision.source,
    scope: decision.scope,
    keywords: decision.keywords,
    supersededBy: decision.supersededBy,
    revision: decision.revision,
    confirmedAt: decision.confirmedAt,
    reviewedAt: decision.reviewedAt,
    createdAt: decision.createdAt,
    updatedAt: decision.updatedAt,
    constraints: store.constraints.listByDecision(decision.id).map((c) => ({
      id: c.id,
      rule: c.rule,
      kind: c.kind,
      severity: c.severity,
      enforcement: c.enforcement,
      scope: c.scope,
      patterns: c.patterns,
      commandPatterns: c.commandPatterns,
      protect: c.protect,
    })),
    evidence: store.evidence.listByDecision(decision.id).map((e) => ({
      id: e.id,
      kind: e.kind,
      source: e.source,
      locator: e.locator,
      description: e.description,
      verifiedAt: e.verifiedAt,
    })),
    alternatives: store.alternatives.listByDecision(decision.id).map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      reason: a.reason,
      keywords: a.keywords,
    })),
    exceptions: store.exceptions.listByDecision(decision.id).map((e) => ({
      id: e.id,
      constraintId: e.constraintId,
      scope: e.scope,
      reason: e.reason,
      approvedBy: e.approvedBy,
      expiresAt: e.expiresAt,
      revokedAt: e.revokedAt,
      createdAt: e.createdAt,
    })),
  }));

  const document = {
    format: EXPORT_FORMAT,
    exportedAt: nowIso(),
    decisions,
    rejectedIdeas: store.alternatives
      .list()
      .filter((a) => !a.decisionId)
      .map((a) => ({ id: a.id, title: a.title, description: a.description, reason: a.reason, keywords: a.keywords })),
  };
  if (options.full) {
    document.conflicts = store.conflicts.list();
    document.history = store.history.list({ limit: 100000 }).reverse();
  }
  return document;
}

/**
 * Import an export document. Existing decisions (same ID) are left untouched;
 * new ones keep their ID, status and provenance.
 */
export function importData(ctx, document, meta = {}) {
  if (!document || typeof document !== 'object' || !Array.isArray(document.decisions)) {
    throw new ValidationError('not an IntentGuard export: expected an object with a "decisions" array');
  }
  if (document.format && document.format !== EXPORT_FORMAT) {
    throw new ValidationError(`unsupported export format "${document.format}" (expected ${EXPORT_FORMAT})`);
  }
  const { store } = ctx;
  const report = { imported: [], skipped: [], rejectedIdeas: 0 };

  return store.tx(() => {
    const ts = nowIso();
    const links = [];

    for (const raw of document.decisions) {
      const data = validateDecisionInput(raw);
      const requestedId = canonicalId(raw.id, 'DEC');
      if (requestedId && store.decisions.get(requestedId)) {
        report.skipped.push({ id: requestedId, reason: 'already exists' });
        continue;
      }
      const status = DECISION_STATUSES.includes(raw.status) ? raw.status : 'proposed';
      if (status !== 'superseded' && status !== 'deprecated' && store.decisions.findByTitle(data.title)) {
        report.skipped.push({ id: requestedId ?? data.title, reason: 'a decision with this title already exists' });
        continue;
      }
      const id = requestedId ?? store.nextId('DEC');
      if (requestedId) store.reserveId('DEC', Number(requestedId.split('-')[1]));
      const createdAt = validDate(raw.createdAt, ts);

      store.decisions.insert({
        id,
        title: data.title,
        statement: data.statement,
        rationale: data.rationale,
        type: data.type,
        status,
        source: data.source,
        scope: data.scope,
        keywords: data.keywords.length ? data.keywords : deriveKeywords(data.title),
        revision: Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1,
        confirmedAt: validDate(raw.confirmedAt, status === 'active' ? ts : null),
        reviewedAt: validDate(raw.reviewedAt, null),
        createdAt,
        updatedAt: validDate(raw.updatedAt, createdAt),
      });
      if (raw.supersededBy) links.push([id, raw.supersededBy]);

      const constraintIds = new Map();
      data.constraints.forEach((constraint, index) => {
        const constraintId = store.nextId('CON');
        const originalId = Array.isArray(raw.constraints) ? raw.constraints[index]?.id : null;
        if (originalId) constraintIds.set(String(originalId).toUpperCase(), constraintId);
        store.constraints.insert({ id: constraintId, decisionId: id, ...constraint, createdAt: ts, updatedAt: ts });
      });
      for (const evidence of data.evidence) {
        store.evidence.insert({
          id: store.nextId('EVD'),
          decisionId: id,
          ...evidence,
          ...stampEvidence(ctx.root, evidence, ts),
          createdAt: ts,
        });
      }
      for (const alternative of data.alternatives) {
        store.alternatives.insert({
          id: store.nextId('ALT'),
          decisionId: id,
          ...alternative,
          keywords: alternative.keywords.length ? alternative.keywords : deriveKeywords(alternative.title),
          createdAt: ts,
        });
      }
      for (const rawException of Array.isArray(raw.exceptions) ? raw.exceptions : []) {
        const exception = validateExceptionInput(rawException);
        const mappedConstraint = exception.constraintId
          ? (constraintIds.get(exception.constraintId.toUpperCase()) ?? null)
          : null;
        store.exceptions.insert({
          id: store.nextId('EXC'),
          decisionId: id,
          constraintId: mappedConstraint,
          scope: exception.scope,
          reason: exception.reason,
          approvedBy: exception.approvedBy,
          expiresAt: exception.expiresAt,
          revokedAt: validDate(rawException.revokedAt, null),
          createdAt: validDate(rawException.createdAt, ts),
        });
      }
      store.history.record({
        entityType: 'decision',
        entityId: id,
        decisionId: id,
        action: 'decision.imported',
        actor: meta.actor ?? 'developer',
        sessionId: meta.sessionId,
        summary: `Imported: ${data.title} (${status}, source: ${data.source})`,
        createdAt: ts,
      });
      report.imported.push(id);
    }

    for (const [id, successor] of links) {
      const target = canonicalId(successor, 'DEC');
      if (target && store.decisions.get(target)) store.decisions.update(id, { supersededBy: target });
    }

    const knownIdeas = new Set(store.alternatives.list().map((a) => a.title.toLowerCase()));
    for (const raw of Array.isArray(document.rejectedIdeas) ? document.rejectedIdeas : []) {
      const idea = validateAlternativeInput(raw);
      if (knownIdeas.has(idea.title.toLowerCase())) continue;
      store.alternatives.insert({
        id: store.nextId('ALT'),
        decisionId: null,
        ...idea,
        keywords: idea.keywords.length ? idea.keywords : deriveKeywords(idea.title),
        createdAt: ts,
      });
      knownIdeas.add(idea.title.toLowerCase());
      report.rejectedIdeas++;
    }
    return report;
  });
}
