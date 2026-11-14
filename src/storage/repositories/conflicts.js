import { updateRow } from './util.js';

const fromRow = (row) =>
  row && {
    id: row.id,
    decisionId: row.decision_id,
    constraintId: row.constraint_id,
    fingerprint: row.fingerprint,
    description: row.description,
    filePath: row.file_path,
    excerpt: row.excerpt,
    verdict: row.verdict,
    confidence: row.confidence,
    detectedBy: row.detected_by,
    status: row.status,
    resolution: row.resolution,
    note: row.note,
    occurrences: row.occurrences,
    sessionId: row.session_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
  };

const COLUMNS = {
  description: 'description',
  excerpt: 'excerpt',
  verdict: 'verdict',
  confidence: 'confidence',
  status: 'status',
  resolution: 'resolution',
  note: 'note',
  occurrences: 'occurrences',
  sessionId: 'session_id',
  lastSeenAt: 'last_seen_at',
  resolvedAt: 'resolved_at',
};

export function conflictsRepo(q) {
  return {
    insert(c) {
      q.run(
        `INSERT INTO conflicts
           (id, decision_id, constraint_id, fingerprint, description, file_path, excerpt, verdict, confidence,
            detected_by, status, resolution, note, occurrences, session_id, first_seen_at, last_seen_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id,
        c.decisionId,
        c.constraintId ?? null,
        c.fingerprint,
        c.description,
        c.filePath ?? null,
        c.excerpt ?? '',
        c.verdict,
        c.confidence,
        c.detectedBy,
        c.status ?? 'pending',
        c.resolution ?? null,
        c.note ?? '',
        c.occurrences ?? 1,
        c.sessionId ?? null,
        c.firstSeenAt,
        c.lastSeenAt ?? c.firstSeenAt,
        c.resolvedAt ?? null,
      );
    },
    update: (id, patch) => updateRow(q, 'conflicts', id, patch, COLUMNS),
    get: (id) => fromRow(q.get('SELECT * FROM conflicts WHERE id = ?', id)),
    getByFingerprint: (fingerprint) => fromRow(q.get('SELECT * FROM conflicts WHERE fingerprint = ?', fingerprint)),
    /** @param {{ status?: string, decisionId?: string }} [filter] */
    list(filter = {}) {
      const where = [];
      const params = [];
      if (filter.status) {
        where.push('status = ?');
        params.push(filter.status);
      }
      if (filter.decisionId) {
        where.push('decision_id = ?');
        params.push(filter.decisionId);
      }
      const sql = `SELECT * FROM conflicts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
      return q.all(sql, ...params).map(fromRow);
    },
    countPending: () => q.get("SELECT COUNT(*) AS n FROM conflicts WHERE status = 'pending'").n,
  };
}
