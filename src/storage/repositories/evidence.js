const fromRow = (row) =>
  row && {
    id: row.id,
    decisionId: row.decision_id,
    kind: row.kind,
    source: row.source,
    locator: row.locator,
    description: row.description,
    contentHash: row.content_hash,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
  };

export function evidenceRepo(q) {
  return {
    insert(e) {
      q.run(
        `INSERT INTO evidence (id, decision_id, kind, source, locator, description, content_hash, verified_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e.id,
        e.decisionId,
        e.kind,
        e.source,
        e.locator ?? '',
        e.description ?? '',
        e.contentHash ?? null,
        e.verifiedAt ?? null,
        e.createdAt,
      );
    },
    get: (id) => fromRow(q.get('SELECT * FROM evidence WHERE id = ?', id)),
    listByDecision: (decisionId) =>
      q.all('SELECT * FROM evidence WHERE decision_id = ? ORDER BY id', decisionId).map(fromRow),
    stamp: (id, contentHash, verifiedAt) =>
      q.run('UPDATE evidence SET content_hash = ?, verified_at = ? WHERE id = ?', contentHash, verifiedAt, id),
    remove: (id) => q.run('DELETE FROM evidence WHERE id = ?', id),
  };
}
