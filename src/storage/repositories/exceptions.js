import { asJson, parseJson } from './util.js';

const fromRow = (row) =>
  row && {
    id: row.id,
    decisionId: row.decision_id,
    constraintId: row.constraint_id,
    scope: parseJson(row.scope, []),
    reason: row.reason,
    approvedBy: row.approved_by,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };

/** Explicit, explained exceptions to a decision. */
export function exceptionsRepo(q) {
  return {
    insert(e) {
      q.run(
        `INSERT INTO exceptions (id, decision_id, constraint_id, scope, reason, approved_by, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e.id,
        e.decisionId,
        e.constraintId ?? null,
        asJson(e.scope ?? []),
        e.reason,
        e.approvedBy ?? 'developer',
        e.expiresAt ?? null,
        e.revokedAt ?? null,
        e.createdAt,
      );
    },
    get: (id) => fromRow(q.get('SELECT * FROM exceptions WHERE id = ?', id)),
    listByDecision: (decisionId) =>
      q.all('SELECT * FROM exceptions WHERE decision_id = ? ORDER BY id', decisionId).map(fromRow),
    list: () => q.all('SELECT * FROM exceptions ORDER BY id').map(fromRow),
    /** Exceptions that are neither revoked nor expired at `now`. */
    listInForce: (now) =>
      q
        .all(
          'SELECT * FROM exceptions WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY id',
          now,
        )
        .map(fromRow),
    revoke: (id, revokedAt) => q.run('UPDATE exceptions SET revoked_at = ? WHERE id = ?', revokedAt, id),
  };
}

export const isInForce = (exception, now) =>
  !exception.revokedAt && (!exception.expiresAt || exception.expiresAt > now);
