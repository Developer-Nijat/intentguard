/**
 * Conflict engine: mechanical comparison of a change against active constraints.
 *
 * It answers with one of four verdicts:
 *   compatible           nothing recorded governs this change, or every detector is clean
 *   unknown              a decision governs this area but has no mechanical detector —
 *                        a semantic judgement (Claude / the developer) is required
 *   potential_conflict   a detector pattern matched; intent still needs confirming
 *   confirmed_violation  a protected path was modified
 *
 * The engine never blocks anything itself and never decides for the developer;
 * callers (hooks, `check`) choose what to do based on the enforcement mode.
 */
import { createHash } from 'node:crypto';
import { nowIso } from '../storage/repositories/util.js';
import { matchesScope } from './scope-matcher.js';
import { VERDICTS, compilePattern } from './validation.js';

const MAX_SCAN_CHARS = 1024 * 1024;
const VERDICT_RANK = Object.fromEntries(VERDICTS.map((verdict, index) => [verdict, index]));

export function worstVerdict(verdicts) {
  let worst = 'compatible';
  for (const verdict of verdicts) if (VERDICT_RANK[verdict] > VERDICT_RANK[worst]) worst = verdict;
  return worst;
}

export const verdictAtLeast = (verdict, threshold) => VERDICT_RANK[verdict] >= VERDICT_RANK[threshold];

/** Snapshot of everything currently in force. Load once per evaluation batch. */
export function loadRules(ctx) {
  const decisions = new Map(ctx.store.decisions.list({ status: 'active' }).map((d) => [d.id, d]));
  const constraintsByDecision = new Map();
  for (const constraint of ctx.store.constraints.listActive()) {
    if (!constraintsByDecision.has(constraint.decisionId)) constraintsByDecision.set(constraint.decisionId, []);
    constraintsByDecision.get(constraint.decisionId).push(constraint);
  }
  return {
    decisions,
    constraintsByDecision,
    exceptions: ctx.store.exceptions.listInForce(nowIso()),
    defaultEnforcement: ctx.config.enforcement,
  };
}

function fingerprint(...parts) {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 20);
}

function findException(rules, decisionId, constraintId, relPath) {
  return (
    rules.exceptions.find(
      (exception) =>
        exception.decisionId === decisionId &&
        (!exception.constraintId || exception.constraintId === constraintId) &&
        (relPath ? matchesScope(relPath, exception.scope) : exception.scope.length === 0),
    ) ?? null
  );
}

function excerptAround(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = text.length;
  const line = text.slice(start, end).trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function firstMatch(patterns, segments) {
  for (const source of patterns) {
    let regex;
    try {
      regex = compilePattern(source);
    } catch {
      continue; // an invalid stored pattern must not break checking
    }
    for (const segment of segments) {
      const text = segment.text.length > MAX_SCAN_CHARS ? segment.text.slice(0, MAX_SCAN_CHARS) : segment.text;
      const match = regex.exec(text);
      if (!match) continue;
      const lineOffset = text.slice(0, match.index).split('\n').length - 1;
      return {
        pattern: source,
        line: Number.isInteger(segment.startLine) ? segment.startLine + lineOffset : null,
        excerpt: excerptAround(text, match.index),
      };
    }
  }
  return null;
}

function finding(rules, decision, constraint, details) {
  return {
    decisionId: decision.id,
    constraintId: constraint.id,
    decision,
    constraint,
    severity: constraint.severity,
    enforcement: constraint.enforcement ?? rules.defaultEnforcement,
    path: null,
    line: null,
    pattern: null,
    excerpt: '',
    ...details,
  };
}

/**
 * Evaluate a change to one file.
 * @param {object} ctx
 * @param {{ path: string, segments?: { startLine?: number|null, text: string }[], rules?: object }} change
 *   `path` is project-relative; `segments` hold the text being added.
 */
export function evaluateFile(ctx, change) {
  const rules = change.rules ?? loadRules(ctx);
  const relPath = change.path;
  const segments = change.segments ?? [];
  const governing = [];
  const findings = [];
  const excepted = [];
  let needsJudgement = false;

  for (const decision of rules.decisions.values()) {
    const all = rules.constraintsByDecision.get(decision.id) ?? [];
    const constraints = all.filter((constraint) => matchesScope(relPath, constraint.scope ?? decision.scope));
    const decisionInScope = matchesScope(relPath, decision.scope);
    if (!decisionInScope && !constraints.length) continue;
    governing.push({ decision, constraints });
    if (!constraints.length) needsJudgement = true; // a bare decision: only its statement to go on

    for (const constraint of constraints) {
      const exception = findException(rules, decision.id, constraint.id, relPath);
      if (exception) {
        excepted.push({ decision, constraint, exception });
        continue;
      }
      if (constraint.protect) {
        findings.push(
          finding(rules, decision, constraint, {
            verdict: 'confirmed_violation',
            confidence: 1,
            detector: 'protect',
            path: relPath,
            description: `${relPath} is protected — ${constraint.rule}`,
            fingerprint: fingerprint(constraint.id, relPath, 'protect'),
          }),
        );
        continue;
      }
      if (!constraint.patterns.length) {
        needsJudgement = true;
        continue;
      }
      const match = firstMatch(constraint.patterns, segments);
      if (match) {
        findings.push(
          finding(rules, decision, constraint, {
            verdict: 'potential_conflict',
            confidence: 0.8,
            detector: 'pattern',
            path: relPath,
            ...match,
            description: `${relPath}${match.line ? `:${match.line}` : ''} matches /${match.pattern}/ — ${constraint.rule}`,
            fingerprint: fingerprint(constraint.id, relPath, `pattern:${match.pattern}`),
          }),
        );
      }
    }
  }

  const verdict = findings.length
    ? worstVerdict(findings.map((f) => f.verdict))
    : needsJudgement
      ? 'unknown'
      : 'compatible';
  return { path: relPath, verdict, findings, governing, excepted };
}

/** Evaluate a shell command against constraints that declare command patterns. */
export function evaluateCommand(ctx, { command, rules = loadRules(ctx) }) {
  const findings = [];
  const excepted = [];
  const segments = [{ startLine: null, text: String(command ?? '') }];
  for (const decision of rules.decisions.values()) {
    for (const constraint of rules.constraintsByDecision.get(decision.id) ?? []) {
      if (!constraint.commandPatterns.length) continue;
      const match = firstMatch(constraint.commandPatterns, segments);
      if (!match) continue;
      const exception = findException(rules, decision.id, constraint.id, null);
      if (exception) {
        excepted.push({ decision, constraint, exception });
        continue;
      }
      findings.push(
        finding(rules, decision, constraint, {
          verdict: 'potential_conflict',
          confidence: 0.8,
          detector: 'command',
          pattern: match.pattern,
          excerpt: match.excerpt,
          description: `Command matches /${match.pattern}/ — ${constraint.rule}`,
          fingerprint: fingerprint(constraint.id, 'command', match.pattern),
        }),
      );
    }
  }
  return {
    verdict: findings.length ? worstVerdict(findings.map((f) => f.verdict)) : 'compatible',
    findings,
    excepted,
  };
}

/**
 * Persist findings as conflicts, de-duplicated by fingerprint so the same
 * problem is one record no matter how many times it is seen.
 *
 * Each finding is annotated with:
 *   conflictId  the CONF-xxxx record
 *   isNew       first time this conflict was ever seen
 *   suppressed  the developer dismissed it as a false positive — stay quiet
 */
export function recordFindings(ctx, findings, meta = {}) {
  if (!findings.length) return findings;
  return ctx.store.tx(() => {
    const ts = nowIso();
    for (const item of findings) {
      const existing = ctx.store.conflicts.getByFingerprint(item.fingerprint);
      if (!existing) {
        const id = ctx.store.nextId('CONF');
        ctx.store.conflicts.insert({
          id,
          decisionId: item.decisionId,
          constraintId: item.constraintId,
          fingerprint: item.fingerprint,
          description: item.description,
          filePath: item.path,
          excerpt: item.excerpt,
          verdict: item.verdict,
          confidence: item.confidence,
          detectedBy: meta.detectedBy ?? 'check',
          sessionId: meta.sessionId ?? null,
          firstSeenAt: ts,
        });
        ctx.store.history.record({
          entityType: 'conflict',
          entityId: id,
          decisionId: item.decisionId,
          action: 'conflict.detected',
          actor: meta.detectedBy ?? 'check',
          sessionId: meta.sessionId,
          summary: `${id}: ${item.description}`,
          createdAt: ts,
        });
        Object.assign(item, { conflictId: id, isNew: true, suppressed: false });
        continue;
      }

      const patch = { lastSeenAt: ts, description: item.description, excerpt: item.excerpt };
      // Count one occurrence per session, not one per edit.
      const newSession = !meta.sessionId || existing.sessionId !== meta.sessionId;
      if (newSession) {
        patch.occurrences = existing.occurrences + 1;
        patch.sessionId = meta.sessionId ?? null;
      }
      const suppressed = existing.status === 'dismissed';
      if (existing.status === 'resolved') {
        // It was settled before and has come back: reopen it.
        Object.assign(patch, { status: 'pending', resolution: null, resolvedAt: null });
      }
      ctx.store.conflicts.update(existing.id, patch);
      Object.assign(item, { conflictId: existing.id, isNew: false, suppressed });
    }
    return findings;
  });
}
