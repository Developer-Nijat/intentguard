/**
 * Hook runner. Claude Code invokes `intentguard hook <event>` with the event
 * payload as JSON on stdin; whatever JSON we print on stdout is the hook result.
 *
 * Two hard rules:
 *   1. A hook must never break a session — every failure is swallowed and logged.
 *   2. Projects that have not run `/intentguard:init` pay almost nothing: we
 *      return before loading the database layer.
 */
import { findProjectRoot, logError } from '../core/project.js';

export const HOOK_EVENTS = {
  'session-start': 'sessionStart',
  'user-prompt-submit': 'userPromptSubmit',
  'pre-tool-use': 'preToolUse',
  'post-tool-use': 'postToolUse',
  stop: 'stop',
};

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Run one hook event against a parsed payload. Returns the output object or null. */
export async function runHook(event, payload = {}) {
  const handlerName = HOOK_EVENTS[event];
  if (!handlerName) return null;

  // Never trust the shape of the payload.
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
  if (typeof input.cwd !== 'string' || !input.cwd) delete input.cwd;
  if (typeof input.session_id !== 'string') delete input.session_id;

  let root = null;
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR;
    root = findProjectRoot(input.cwd || projectDir || process.cwd()) ?? (projectDir ? findProjectRoot(projectDir) : null);
  } catch {
    return null;
  }
  if (!root) return null;

  let ctx;
  try {
    const [{ openContext }, handlers] = await Promise.all([import('../core/context.js'), import('./handlers.js')]);
    ctx = openContext(root);
    return handlers[handlerName](ctx, input) ?? null;
  } catch (error) {
    logError(root, `hook:${event}`, error);
    return null;
  } finally {
    ctx?.close();
  }
}

/** CLI entry: read stdin, run the hook, print the result. Always exits 0. */
export async function hookMain(event) {
  let input = {};
  try {
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  try {
    const output = await runHook(event, input);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    /* rule 1: a hook never breaks a session */
  }
}
