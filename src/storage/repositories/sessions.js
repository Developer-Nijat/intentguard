import { nowIso } from './util.js';

/**
 * Per-session bookkeeping used by hooks: what has already been shown or
 * approved, so the same warning is not repeated over and over.
 */
export function sessionsRepo(q) {
  return {
    /** Record a marker. Returns true when it was new for this session. */
    mark(sessionId, kind, key, value = '') {
      if (!sessionId) return true;
      const result = q.run(
        'INSERT OR IGNORE INTO session_events (session_id, kind, key, value, created_at) VALUES (?, ?, ?, ?, ?)',
        sessionId,
        kind,
        key,
        value,
        nowIso(),
      );
      return Number(result.changes) > 0;
    },
    has(sessionId, kind, key) {
      if (!sessionId) return false;
      return Boolean(
        q.get('SELECT 1 AS hit FROM session_events WHERE session_id = ? AND kind = ? AND key = ?', sessionId, kind, key),
      );
    },
    get(sessionId, kind, key) {
      if (!sessionId) return null;
      return (
        q.get('SELECT value, created_at AS createdAt FROM session_events WHERE session_id = ? AND kind = ? AND key = ?', sessionId, kind, key) ??
        null
      );
    },
    list(sessionId, kind) {
      if (!sessionId) return [];
      return q
        .all(
          'SELECT key, value, created_at AS createdAt FROM session_events WHERE session_id = ? AND kind = ? ORDER BY created_at',
          sessionId,
          kind,
        )
        .map((row) => ({ ...row }));
    },
    remove: (sessionId, kind, key) =>
      q.run('DELETE FROM session_events WHERE session_id = ? AND kind = ? AND key = ?', sessionId, kind, key),
    /** Forget markers of the given kinds (e.g. after context compaction). */
    clear(sessionId, kinds) {
      if (!sessionId || !kinds.length) return;
      q.run(
        `DELETE FROM session_events WHERE session_id = ? AND kind IN (${kinds.map(() => '?').join(', ')})`,
        sessionId,
        ...kinds,
      );
    },
    prune: (olderThan) => q.run('DELETE FROM session_events WHERE created_at < ?', olderThan),
  };
}
