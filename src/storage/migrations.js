/**
 * Schema migrations. The schema version is stored in `PRAGMA user_version`.
 * Append new migrations to the end; never edit one that has shipped.
 */
export const MIGRATIONS = [
  /* v1 — initial schema */
  `
  CREATE TABLE counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  CREATE TABLE decisions (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    statement     TEXT NOT NULL,
    rationale     TEXT NOT NULL DEFAULT '',
    type          TEXT NOT NULL DEFAULT 'architectural',
    status        TEXT NOT NULL DEFAULT 'proposed',
    source        TEXT NOT NULL DEFAULT 'developer',
    scope         TEXT NOT NULL DEFAULT '[]',
    keywords      TEXT NOT NULL DEFAULT '[]',
    superseded_by TEXT REFERENCES decisions(id) ON DELETE SET NULL,
    revision      INTEGER NOT NULL DEFAULT 1,
    confirmed_at  TEXT,
    reviewed_at   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX idx_decisions_status ON decisions(status);

  CREATE TABLE constraints (
    id               TEXT PRIMARY KEY,
    decision_id      TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    rule             TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'must_not',
    severity         TEXT NOT NULL DEFAULT 'medium',
    enforcement      TEXT,
    scope            TEXT,
    patterns         TEXT NOT NULL DEFAULT '[]',
    command_patterns TEXT NOT NULL DEFAULT '[]',
    protect          INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX idx_constraints_decision ON constraints(decision_id);

  CREATE TABLE evidence (
    id           TEXT PRIMARY KEY,
    decision_id  TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL DEFAULT 'note',
    source       TEXT NOT NULL,
    locator      TEXT NOT NULL DEFAULT '',
    description  TEXT NOT NULL DEFAULT '',
    content_hash TEXT,
    verified_at  TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX idx_evidence_decision ON evidence(decision_id);

  CREATE TABLE alternatives (
    id               TEXT PRIMARY KEY,
    decision_id      TEXT REFERENCES decisions(id) ON DELETE SET NULL,
    title            TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    rejection_reason TEXT NOT NULL,
    keywords         TEXT NOT NULL DEFAULT '[]',
    status           TEXT NOT NULL DEFAULT 'rejected',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  CREATE TABLE conflicts (
    id            TEXT PRIMARY KEY,
    decision_id   TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    constraint_id TEXT REFERENCES constraints(id) ON DELETE SET NULL,
    fingerprint   TEXT NOT NULL UNIQUE,
    description   TEXT NOT NULL,
    file_path     TEXT,
    excerpt       TEXT NOT NULL DEFAULT '',
    verdict       TEXT NOT NULL DEFAULT 'potential_conflict',
    confidence    REAL NOT NULL DEFAULT 0.5,
    detected_by   TEXT NOT NULL DEFAULT 'check',
    status        TEXT NOT NULL DEFAULT 'pending',
    resolution    TEXT,
    note          TEXT NOT NULL DEFAULT '',
    occurrences   INTEGER NOT NULL DEFAULT 1,
    session_id    TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    resolved_at   TEXT
  );
  CREATE INDEX idx_conflicts_status ON conflicts(status);
  CREATE INDEX idx_conflicts_decision ON conflicts(decision_id);

  CREATE TABLE exceptions (
    id            TEXT PRIMARY KEY,
    decision_id   TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    constraint_id TEXT REFERENCES constraints(id) ON DELETE CASCADE,
    scope         TEXT NOT NULL DEFAULT '[]',
    reason        TEXT NOT NULL,
    approved_by   TEXT NOT NULL DEFAULT 'developer',
    expires_at    TEXT,
    revoked_at    TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_exceptions_decision ON exceptions(decision_id);

  CREATE TABLE history (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    decision_id TEXT,
    action      TEXT NOT NULL,
    actor       TEXT NOT NULL DEFAULT 'developer',
    session_id  TEXT,
    summary     TEXT NOT NULL DEFAULT '',
    changes     TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_history_decision ON history(decision_id);

  CREATE TABLE session_events (
    session_id TEXT NOT NULL,
    kind       TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, kind, key)
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `This IntentGuard database (schema v${current}) was created by a newer version of the plugin. Please update IntentGuard.`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
