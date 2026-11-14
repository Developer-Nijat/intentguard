import { asJson, parseJson } from './util.js';

const fromRow = (row) =>
  row && {
    id: row.id,
    decisionId: row.decision_id,
    title: row.title,
    description: row.description,
    reason: row.rejection_reason,
    keywords: parseJson(row.keywords, []),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

/** Rejected ideas: what was considered and turned down, and why. */
export function alternativesRepo(q) {
  return {
    insert(a) {
      q.run(
        `INSERT INTO alternatives (id, decision_id, title, description, rejection_reason, keywords, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        a.decisionId ?? null,
        a.title,
        a.description ?? '',
        a.reason,
        asJson(a.keywords ?? []),
        a.status ?? 'rejected',
        a.createdAt,
        a.updatedAt ?? a.createdAt,
      );
    },
    get: (id) => fromRow(q.get('SELECT * FROM alternatives WHERE id = ?', id)),
    listByDecision: (decisionId) =>
      q.all('SELECT * FROM alternatives WHERE decision_id = ? ORDER BY id', decisionId).map(fromRow),
    /** @param {{ status?: string }} [filter] */
    list(filter = {}) {
      if (filter.status) return q.all('SELECT * FROM alternatives WHERE status = ? ORDER BY id', filter.status).map(fromRow);
      return q.all('SELECT * FROM alternatives ORDER BY id').map(fromRow);
    },
    setStatus: (id, status, updatedAt) =>
      q.run('UPDATE alternatives SET status = ?, updated_at = ? WHERE id = ?', status, updatedAt, id),
    remove: (id) => q.run('DELETE FROM alternatives WHERE id = ?', id),
  };
}
