import { asJson, parseJson, updateRow } from './util.js';

const fromRow = (row) =>
  row && {
    id: row.id,
    title: row.title,
    statement: row.statement,
    rationale: row.rationale,
    type: row.type,
    status: row.status,
    source: row.source,
    scope: parseJson(row.scope, []),
    keywords: parseJson(row.keywords, []),
    supersededBy: row.superseded_by,
    revision: row.revision,
    confirmedAt: row.confirmed_at,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

const COLUMNS = {
  title: 'title',
  statement: 'statement',
  rationale: 'rationale',
  type: 'type',
  status: 'status',
  source: 'source',
  scope: ['scope', asJson],
  keywords: ['keywords', asJson],
  supersededBy: 'superseded_by',
  revision: 'revision',
  confirmedAt: 'confirmed_at',
  reviewedAt: 'reviewed_at',
  updatedAt: 'updated_at',
};

export function decisionsRepo(q) {
  return {
    insert(d) {
      q.run(
        `INSERT INTO decisions
           (id, title, statement, rationale, type, status, source, scope, keywords,
            superseded_by, revision, confirmed_at, reviewed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.id,
        d.title,
        d.statement,
        d.rationale ?? '',
        d.type,
        d.status,
        d.source,
        asJson(d.scope ?? []),
        asJson(d.keywords ?? []),
        d.supersededBy ?? null,
        d.revision ?? 1,
        d.confirmedAt ?? null,
        d.reviewedAt ?? null,
        d.createdAt,
        d.updatedAt,
      );
    },
    update: (id, patch) => updateRow(q, 'decisions', id, patch, COLUMNS),
    get: (id) => fromRow(q.get('SELECT * FROM decisions WHERE id = ?', id)),
    findByTitle: (title) =>
      fromRow(
        q.get(
          "SELECT * FROM decisions WHERE lower(title) = lower(?) AND status IN ('active', 'proposed') LIMIT 1",
          title,
        ),
      ),
    /** @param {{ status?: string | string[], type?: string }} [filter] */
    list(filter = {}) {
      const where = [];
      const params = [];
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        params.push(...statuses);
      }
      if (filter.type) {
        where.push('type = ?');
        params.push(filter.type);
      }
      const sql = `SELECT * FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
      return q.all(sql, ...params).map(fromRow);
    },
    countByStatus() {
      const counts = {};
      for (const row of q.all('SELECT status, COUNT(*) AS n FROM decisions GROUP BY status')) counts[row.status] = row.n;
      return counts;
    },
    remove: (id) => q.run('DELETE FROM decisions WHERE id = ?', id),
  };
}
