import { asJson, parseJson } from './util.js';

const fromRow = (row) =>
  row && {
    id: row.id,
    decisionId: row.decision_id,
    rule: row.rule,
    kind: row.kind,
    severity: row.severity,
    enforcement: row.enforcement,
    scope: parseJson(row.scope, null),
    patterns: parseJson(row.patterns, []),
    commandPatterns: parseJson(row.command_patterns, []),
    protect: row.protect === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

export function constraintsRepo(q) {
  return {
    insert(c) {
      q.run(
        `INSERT INTO constraints
           (id, decision_id, rule, kind, severity, enforcement, scope, patterns, command_patterns, protect, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id,
        c.decisionId,
        c.rule,
        c.kind,
        c.severity,
        c.enforcement ?? null,
        asJson(c.scope),
        asJson(c.patterns ?? []),
        asJson(c.commandPatterns ?? []),
        c.protect ? 1 : 0,
        c.createdAt,
        c.updatedAt ?? c.createdAt,
      );
    },
    get: (id) => fromRow(q.get('SELECT * FROM constraints WHERE id = ?', id)),
    listByDecision: (decisionId) =>
      q.all('SELECT * FROM constraints WHERE decision_id = ? ORDER BY id', decisionId).map(fromRow),
    /** Constraints belonging to active decisions — the only ones that are checked. */
    listActive: () =>
      q
        .all(
          `SELECT c.* FROM constraints c
             JOIN decisions d ON d.id = c.decision_id
            WHERE d.status = 'active'
            ORDER BY c.id`,
        )
        .map(fromRow),
    remove: (id) => q.run('DELETE FROM constraints WHERE id = ?', id),
  };
}
