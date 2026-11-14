/**
 * SQLite access through Node's built-in `node:sqlite` — no native addon to
 * compile, so the plugin works straight from a git clone on every platform.
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './migrations.js';

let DatabaseSync;
{
  // node:sqlite prints an ExperimentalWarning on load in Node 22; keep hook output clean.
  const emitWarning = process.emitWarning;
  process.emitWarning = function patchedEmitWarning(warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    const message = typeof warning === 'string' ? warning : warning?.message;
    if ((type === 'ExperimentalWarning' || warning?.name === 'ExperimentalWarning') && /sqlite/i.test(message ?? '')) {
      return;
    }
    return emitWarning.call(process, warning, ...rest);
  };
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (error) {
    throw new Error(
      `IntentGuard needs Node.js 22.13 or newer (it uses the built-in node:sqlite module). Current version: ${process.version}.`,
      { cause: error },
    );
  } finally {
    process.emitWarning = emitWarning;
  }
}

const bindable = (value) => {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
};

/** Open (and migrate) a database file. Use ":memory:" for tests. */
export function openDatabase(file) {
  const inMemory = file === ':memory:';
  if (!inMemory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 4000');
  db.exec('PRAGMA foreign_keys = ON');
  if (!inMemory) {
    // WAL lets parallel hook processes read while one writes.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  migrate(db);
  return db;
}

const txDepth = new WeakMap();

/** Small query helper bound to one connection. */
export function createQuery(db) {
  const statements = new Map();
  const prepare = (sql) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  return {
    all: (sql, ...params) => prepare(sql).all(...params.map(bindable)),
    get: (sql, ...params) => prepare(sql).get(...params.map(bindable)),
    run: (sql, ...params) => prepare(sql).run(...params.map(bindable)),
    /** Run `fn` atomically. Nested calls join the outer transaction. */
    tx(fn) {
      const depth = txDepth.get(db) ?? 0;
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      txDepth.set(db, 1);
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        txDepth.set(db, 0);
      }
    },
  };
}
