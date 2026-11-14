import { asJson, nowIso, parseJson } from './util.js';

const fromRow = (row) =>
  row && {
    seq: row.seq,
    entityType: row.entity_type,
    entityId: row.entity_id,
    decisionId: row.decision_id,
    action: row.action,
    actor: row.actor,
    sessionId: row.session_id,
    summary: row.summary,
    changes: parseJson(row.changes, null),
    createdAt: row.created_at,
  };

/** Append-only audit trail of everything that happened to a decision. */
export function historyRepo(q) {
  return {
    record(entry) {
      q.run(
        `INSERT INTO history (entity_type, entity_id, decision_id, action, actor, session_id, summary, changes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.entityType,
        entry.entityId,
        entry.decisionId ?? null,
        entry.action,
        entry.actor ?? 'developer',
        entry.sessionId ?? null,
        entry.summary ?? '',
        asJson(entry.changes),
        entry.createdAt ?? nowIso(),
      );
    },
    /** @param {{ decisionId?: string, limit?: number, action?: string }} [filter] */
    list(filter = {}) {
      const where = [];
      const params = [];
      if (filter.decisionId) {
        where.push('decision_id = ?');
        params.push(filter.decisionId);
      }
      if (filter.action) {
        where.push('action = ?');
        params.push(filter.action);
      }
      const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 50;
      const sql = `SELECT * FROM history ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
      return q.all(sql, ...params, limit).map(fromRow);
    },
    /** Was any decision recorded at or after `since`? */
    decisionCreatedSince: (since) =>
      Boolean(q.get("SELECT 1 AS hit FROM history WHERE action = 'decision.created' AND created_at >= ? LIMIT 1", since)),
  };
}
