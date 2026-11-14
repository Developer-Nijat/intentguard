import { createQuery } from './database.js';
import { alternativesRepo } from './repositories/alternatives.js';
import { conflictsRepo } from './repositories/conflicts.js';
import { constraintsRepo } from './repositories/constraints.js';
import { decisionsRepo } from './repositories/decisions.js';
import { evidenceRepo } from './repositories/evidence.js';
import { exceptionsRepo } from './repositories/exceptions.js';
import { historyRepo } from './repositories/history.js';
import { sessionsRepo } from './repositories/sessions.js';

export const ID_PREFIXES = {
  decision: 'DEC',
  constraint: 'CON',
  evidence: 'EVD',
  alternative: 'ALT',
  conflict: 'CONF',
  exception: 'EXC',
};

export const formatId = (prefix, number) => `${prefix}-${String(number).padStart(4, '0')}`;

/**
 * Accepts "DEC-12", "dec-0012" or "DEC12" and returns "DEC-0012".
 * Returns null when the input is not an ID with the expected prefix.
 */
export function canonicalId(input, prefix) {
  const match = /^([a-z]+)-?(\d+)$/i.exec(String(input ?? '').trim());
  if (!match) return null;
  if (prefix && match[1].toUpperCase() !== prefix) return null;
  return formatId(match[1].toUpperCase(), Number(match[2]));
}

/** All repositories over one database connection. */
export function createStore(db) {
  const q = createQuery(db);
  return {
    q,
    tx: q.tx,
    decisions: decisionsRepo(q),
    constraints: constraintsRepo(q),
    evidence: evidenceRepo(q),
    alternatives: alternativesRepo(q),
    conflicts: conflictsRepo(q),
    exceptions: exceptionsRepo(q),
    history: historyRepo(q),
    sessions: sessionsRepo(q),
    /** Allocate the next sequential ID for a prefix, e.g. "DEC-0007". */
    nextId(prefix) {
      const row = q.get(
        `INSERT INTO counters (name, value) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET value = value + 1
         RETURNING value`,
        prefix,
      );
      return formatId(prefix, row.value);
    },
    /** Make sure future IDs for a prefix start above `number` (used by import). */
    reserveId(prefix, number) {
      q.run(
        `INSERT INTO counters (name, value) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)`,
        prefix,
        number,
      );
    },
  };
}
