/**
 * Hook handlers. Hooks do the mechanical part only — matching paths, patterns
 * and keywords — and put the right decision records in front of Claude.
 * Semantic judgement stays with Claude and the developer.
 */
import { createHash } from 'node:crypto';
import { conflictNotice, governingNotice, promptNotice, sessionSummary } from '../cli/format.js';
import { evaluateCommand, evaluateFile, loadRules, recordFindings } from '../core/conflict-engine.js';
import { toRelative } from '../core/project.js';
import { findRelevant, looksLikeDecision } from '../core/relevance.js';
import { classifyOwnState } from './self-guard.js';

const MAX_CONTEXT_CHARS = 8000;
const SESSION_RETENTION_DAYS = 30;
const MAX_NUDGES_PER_SESSION = 3;

const clip = (text) => (text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n…(truncated; run \`intentguard list\` for everything)` : text);
const shortHash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16);
const context = (hookEventName, text) => ({ hookSpecificOutput: { hookEventName, additionalContext: clip(text) } });

/* ------------------------------------------------------------ SessionStart */

export function sessionStart(ctx, input) {
  const sessionId = input.session_id;
  const cutoff = new Date(Date.now() - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  ctx.store.sessions.prune(cutoff);
  // After compaction or /clear Claude has forgotten earlier reminders; allow them again.
  if (input.source === 'compact' || input.source === 'clear') {
    ctx.store.sessions.clear(sessionId, ['shown', 'notified', 'prompt']);
  }
  return context('SessionStart', sessionSummary(ctx));
}

/* -------------------------------------------------------- UserPromptSubmit */

const CAPTURE_HINT =
  'IntentGuard: this message may state a durable engineering decision. When the requested work is done, briefly offer to record it (/intentguard:remember). Never record a decision without the developer\'s explicit confirmation. If it is only a one-off instruction, ignore this note.';

export function userPromptSubmit(ctx, input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt.trim() || prompt.trimStart().startsWith('/')) return null;
  const sessionId = input.session_id;
  const parts = [];

  const matches = findRelevant(ctx, prompt);
  // Surface each record once per session; repeating it on every prompt is noise.
  const fresh = {
    decisions: matches.decisions.filter(({ decision }) => ctx.store.sessions.mark(sessionId, 'prompt', decision.id)),
    alternatives: matches.alternatives.filter(({ alternative }) => ctx.store.sessions.mark(sessionId, 'prompt', alternative.id)),
  };
  const notice = promptNotice(ctx, fresh);
  if (notice) parts.push(notice);

  if (ctx.config.capture?.suggest !== false && looksLikeDecision(prompt)) {
    ctx.store.sessions.mark(sessionId, 'candidate', shortHash(prompt), prompt.trim().slice(0, 240));
    parts.push(CAPTURE_HINT);
  }

  return parts.length ? context('UserPromptSubmit', parts.join('\n\n')) : null;
}

/* -------------------------------------------------------------- PreToolUse */

/** Normalise a tool call into either a file change or a shell command. */
export function describeToolCall(ctx, input) {
  const tool = input.tool_name;
  const args = input.tool_input ?? {};
  const text = (value) => (typeof value === 'string' ? value : '');
  const file = (value) => toRelative(ctx.root, value, input.cwd || ctx.root);

  switch (tool) {
    case 'Write':
      return { kind: 'file', path: file(args.file_path), segments: [{ startLine: 1, text: text(args.content) }] };
    case 'Edit':
      return { kind: 'file', path: file(args.file_path), segments: [{ startLine: null, text: text(args.new_string) }] };
    case 'MultiEdit':
      return {
        kind: 'file',
        path: file(args.file_path),
        segments: (Array.isArray(args.edits) ? args.edits : []).map((edit) => ({ startLine: null, text: text(edit?.new_string) })),
      };
    case 'NotebookEdit':
      return { kind: 'file', path: file(args.notebook_path), segments: [{ startLine: null, text: text(args.new_source) }] };
    case 'Bash':
    case 'PowerShell':
      return { kind: 'command', command: text(args.command), shell: tool === 'PowerShell' ? 'powershell' : 'bash', cwd: input.cwd || ctx.root };
    default:
      return null;
  }
}

export function preToolUse(ctx, input) {
  const call = describeToolCall(ctx, input);
  if (!call) return null;
  if (call.kind === 'command' && !call.command.trim()) return null;

  // IntentGuard guards itself first, in every enforcement mode (see self-guard.js).
  const own = classifyOwnState(call);
  if (own?.ask) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: own.ask } };
  }
  if (own?.exempt) return null;

  const sessionId = input.session_id;
  const { sessions } = ctx.store;
  const rules = loadRules(ctx);
  if (!rules.decisions.size) return null;

  let result;
  if (call.kind === 'file') {
    if (!call.path) return null;
    result = evaluateFile(ctx, { path: call.path, segments: call.segments, rules });
  } else {
    result = { ...evaluateCommand(ctx, { command: call.command, rules }), governing: [] };
  }

  recordFindings(ctx, result.findings, { sessionId, detectedBy: 'hook' });
  // `observe` only records; dismissed false positives stay quiet for good.
  const live = result.findings.filter((finding) => !finding.suppressed && finding.enforcement !== 'observe');

  const needApproval = live.filter(
    (finding) => finding.enforcement === 'enforce' && !sessions.has(sessionId, 'approved', finding.fingerprint),
  );
  // Warn once per session per conflict (criterion: no repeated nagging).
  const toWarn = live.filter(
    (finding) => !needApproval.includes(finding) && sessions.mark(sessionId, 'notified', finding.fingerprint),
  );

  const parts = [];
  if (needApproval.length || toWarn.length) parts.push(conflictNotice(ctx, [...needApproval, ...toWarn]));

  // Just-in-time reminder of decisions governing this file, once per session each.
  if (call.kind === 'file') {
    const flagged = new Set(result.findings.map((finding) => finding.decisionId));
    const reminders = result.governing.filter(
      ({ decision }) => !flagged.has(decision.id) && sessions.mark(sessionId, 'shown', decision.id),
    );
    if (reminders.length) parts.push(governingNotice(ctx, call.path, reminders));
  }

  if (!parts.length) return null;
  const output = context('PreToolUse', parts.join('\n\n'));

  if (needApproval.length) {
    if (input.tool_use_id) {
      sessions.mark(sessionId, 'asked', input.tool_use_id, JSON.stringify(needApproval.map((finding) => finding.fingerprint)));
    }
    const summary = needApproval
      .map((finding) => `${finding.decision.id} "${finding.decision.title}" — ${finding.constraint.rule} [${finding.conflictId}]`)
      .join('; ');
    output.hookSpecificOutput.permissionDecision = 'ask';
    output.hookSpecificOutput.permissionDecisionReason = `IntentGuard: this change conflicts with an enforced decision: ${summary}. Approve only if you consciously accept it; deny to keep the decision.`;
  }
  return output;
}

/* ------------------------------------------------------------- PostToolUse */

export function postToolUse(ctx, input) {
  const sessionId = input.session_id;
  const { sessions } = ctx.store;

  // The tool ran, so an approval we asked for was granted: remember it for this session.
  if (input.tool_use_id) {
    const asked = sessions.get(sessionId, 'asked', input.tool_use_id);
    if (asked) {
      let fingerprints = [];
      try {
        fingerprints = JSON.parse(asked.value);
      } catch {
        fingerprints = [];
      }
      for (const fingerprint of fingerprints) {
        sessions.mark(sessionId, 'approved', fingerprint);
        sessions.mark(sessionId, 'notified', fingerprint);
      }
      sessions.remove(sessionId, 'asked', input.tool_use_id);
    }
  }

  const call = describeToolCall(ctx, input);
  if (call?.kind === 'file' && call.path) sessions.mark(sessionId, 'touched', call.path);
  return null;
}

/* -------------------------------------------------------------------- Stop */

const ALREADY_OFFERED = /intentguard|\/remember|record (?:this|that|it|the) (?:as a )?decision|decision record/i;

export function stop(ctx, input) {
  if (input.stop_hook_active === true) return null;
  if (ctx.config.capture?.suggest === false) return null;
  const sessionId = input.session_id;
  if (!sessionId) return null;
  const { sessions, history } = ctx.store;

  const candidates = sessions.list(sessionId, 'candidate').filter((c) => !sessions.has(sessionId, 'nudged', c.key));
  if (!candidates.length) return null;
  // Whatever happens below, each candidate is considered exactly once.
  for (const candidate of candidates) sessions.mark(sessionId, 'nudged', candidate.key);

  const earliest = candidates[0].createdAt;
  if (history.decisionCreatedSince(earliest)) return null;
  if (ALREADY_OFFERED.test(String(input.last_assistant_message ?? ''))) return null;
  if (sessions.list(sessionId, 'nudge-sent').length >= MAX_NUDGES_PER_SESSION) return null;
  sessions.mark(sessionId, 'nudge-sent', candidates[0].key);

  const quoted = candidates.map((c) => `"${c.value}"`).join('\n');
  return {
    decision: 'block',
    reason: [
      'IntentGuard: earlier in this session the developer wrote something that reads like a durable engineering decision:',
      quoted,
      'If it is a lasting decision for this project, ask the developer in one short sentence whether to record it with IntentGuard (/intentguard:remember) — do not record anything without their confirmation. If it was only a one-off instruction, simply finish without mentioning this.',
    ].join('\n'),
  };
}
