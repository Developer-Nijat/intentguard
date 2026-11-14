/**
 * Project discovery, paths and configuration.
 * All IntentGuard state for a project lives in `<project>/.intentguard/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENFORCEMENTS } from './validation.js';
import { normalizePath } from './scope-matcher.js';

export const DATA_DIR = '.intentguard';
export const DB_FILE = 'intentguard.db';
export const CONFIG_FILE = 'config.json';
export const EXPORT_FILE = 'decisions.json';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  /** Default enforcement for constraints that do not set their own: observe | warn | enforce. */
  enforcement: 'warn',
  context: {
    /** Max decisions listed in the session-start summary. */
    sessionDecisions: 12,
    /** Max decisions surfaced for one user prompt. */
    promptMatches: 3,
  },
  capture: {
    /** Suggest recording a decision when the developer appears to state one. */
    suggest: true,
  },
  review: {
    /** A decision not reviewed for this many days is flagged by `review`. */
    staleAfterDays: 180,
  },
});

function exists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function walkUp(startDir, predicate) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Nearest ancestor (or self) that has been initialised with IntentGuard. */
export function findProjectRoot(startDir) {
  return walkUp(startDir, (dir) => exists(path.join(dir, DATA_DIR, CONFIG_FILE)) || exists(path.join(dir, DATA_DIR, DB_FILE)));
}

/** Nearest ancestor (or self) containing a `.git` entry. */
export function findGitRoot(startDir) {
  return walkUp(startDir, (dir) => exists(path.join(dir, '.git')));
}

export const dataDir = (root) => path.join(root, DATA_DIR);
export const dbPath = (root) => path.join(root, DATA_DIR, DB_FILE);
export const configPath = (root) => path.join(root, DATA_DIR, CONFIG_FILE);

function mergeConfig(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = mergeConfig(base[key], value);
    } else if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

/** Load config merged over defaults. A broken config file never breaks a session. */
export function loadConfig(root) {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
  } catch {
    user = {};
  }
  const config = mergeConfig(DEFAULT_CONFIG, user);
  if (!ENFORCEMENTS.includes(config.enforcement)) config.enforcement = DEFAULT_CONFIG.enforcement;
  return config;
}

export function saveConfig(root, config) {
  fs.mkdirSync(dataDir(root), { recursive: true });
  fs.writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Convert an absolute or relative path into a forward-slash path relative to
 * the project root. Returns null for paths outside the project.
 */
export function toRelative(root, filePath, cwd = root) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  let candidate = filePath.trim();
  // Git Bash style "/c/Users/..." on Windows.
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(candidate)) {
    candidate = `${candidate[1]}:${candidate.slice(2)}`;
  }
  const absolute = path.resolve(cwd || root, candidate);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return normalizePath(relative);
}

const GITIGNORE = `# IntentGuard local state. The database stays on this machine.
# To share decisions with your team, run \`intentguard export\` and commit decisions.json.
*.db
*.db-wal
*.db-shm
*.db-journal
logs/
`;

/** Create the data directory, config and ignore file. Idempotent. */
export function initProjectFiles(root, overrides = {}) {
  fs.mkdirSync(dataDir(root), { recursive: true });
  const created = !exists(configPath(root));
  if (created) {
    saveConfig(root, mergeConfig(DEFAULT_CONFIG, overrides));
  } else if (Object.keys(overrides).length) {
    saveConfig(root, mergeConfig(loadConfig(root), overrides));
  }
  const ignoreFile = path.join(dataDir(root), '.gitignore');
  if (!exists(ignoreFile)) fs.writeFileSync(ignoreFile, GITIGNORE);
  return { created };
}

/** Append a line to the hook error log; never throws. */
export function logError(root, where, error) {
  try {
    const dir = path.join(dataDir(root), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} [${where}] ${error?.stack ?? error}\n`;
    fs.appendFileSync(path.join(dir, 'errors.log'), line);
  } catch {
    /* logging must never break a hook */
  }
}
