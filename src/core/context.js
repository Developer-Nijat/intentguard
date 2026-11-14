import { openDatabase } from '../storage/database.js';
import { createStore } from '../storage/store.js';
import { DEFAULT_CONFIG, dbPath, loadConfig } from './project.js';

/**
 * Open a project: database connection, repositories and config in one handle.
 * Pass `{ memory: true }` for an isolated in-memory database (tests).
 */
export function openContext(root, options = {}) {
  const db = openDatabase(options.memory ? ':memory:' : dbPath(root));
  const config = options.config ?? (options.memory ? structuredClone(DEFAULT_CONFIG) : loadConfig(root));
  return {
    root,
    config,
    db,
    store: createStore(db),
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}
