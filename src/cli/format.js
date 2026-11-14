/**
 * Plain-text rendering shared by the CLI and the hooks. Output is written to be
 * read by both a developer and Claude: compact, and always anchored to IDs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveEvidence } from '../core/evidence-resolver.js';
import { DATA_DIR, EXPORT_FILE, dataDir } from '../core/project.js';

const day = (iso) => (iso ? iso.slice(0, 10) : '—');
const scopeText = (scope) => (scope?.length ? scope.join(', ') : 'whole project');
const kindText = (kind) => (kind === 'must' ? 'MUST' : 'MUST NOT');
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function decisionLine(decision) {
  const flag = decision.status === 'active' ? '' : ` (${decision.status})`;
  return `${decision.id} [${decision.type}]${flag} ${decision.title} — scope: ${scopeText(decision.scope)}`;
}

function detectorText(constraint) {
  const parts = [];
  if (constraint.protect) parts.push('protected path (any change)');
  if (constraint.patterns.length) parts.push(`content ${constraint.patterns.map((p) => `/${p}/`).join(' ')}`);
  if (constraint.commandPatterns.length) parts.push(`commands ${constraint.commandPatterns.map((p) => `/${p}/`).join(' ')}`);
  return parts.length ? parts.join('; ') : 'none — needs semantic review';
}

export function constraintLine(constraint, defaultEnforcement) {
  const enforcement = constraint.enforcement ?? defaultEnforcement ?? 'warn';
  const scope = constraint.scope ? ` (scope: ${scopeText(constraint.scope)})` : '';
  return `${constraint.id} ${kindText(constraint.kind)} [${constraint.severity}, ${enforcement}]: ${constraint.rule}${scope}`;
}

export function evidenceLine(evidence, root) {
  const where = `${evidence.source}${evidence.locator ? ` (${evidence.locator})` : ''}`;
  let state = '';
  if (root) {
    const resolved = resolveEvidence(root, evidence).state;
    if (resolved === 'verified') state = ` — verified ${day(evidence.verifiedAt)}`;
    else if (resolved === 'changed') state = ` — CHANGED since verified ${day(evidence.verifiedAt)}`;
    else if (resolved === 'missing') state = ' — MISSING';
    else if (resolved === 'unverified') state = ' — not verified';
  }
  return `${evidence.id} ${evidence.kind}: ${where}${evidence.description ? ` — ${evidence.description}` : ''}${state}`;
}

const SOURCE_TEXT = {
  developer: 'stated by the developer',
  document: 'extracted from a document',
  git: 'inferred from git history',
  claude: 'suggested by Claude',
};

/** Full record of one decision. */
export function formatDecision(full, options = {}) {
  const lines = [];
  lines.push(`${full.id} · ${full.title}`);
  const status =
    full.status === 'active'
      ? `active (confirmed ${day(full.confirmedAt)})`
      : full.status === 'superseded'
        ? `superseded by ${full.supersededBy ?? '?'}`
        : full.status === 'proposed'
          ? 'PROPOSED — not confirmed by the developer, not enforced'
          : full.status;
  lines.push(`Status: ${status} · Type: ${full.type} · Source: ${SOURCE_TEXT[full.source] ?? full.source} · Revision ${full.revision}`);
  lines.push(`Scope: ${scopeText(full.scope)}`);
  lines.push(`Decision: ${full.statement}`);
  lines.push(`Reason: ${full.rationale || '(none recorded)'}`);
  if (full.keywords?.length) lines.push(`Keywords: ${full.keywords.join(', ')}`);

  if (full.constraints?.length) {
    lines.push('Constraints:');
    for (const constraint of full.constraints) {
      lines.push(`  ${constraintLine(constraint, options.defaultEnforcement)}`);
      lines.push(`      detectors: ${detectorText(constraint)}`);
    }
  }
  lines.push('Evidence:');
  if (full.evidence?.length) {
    for (const evidence of full.evidence) lines.push(`  ${evidenceLine(evidence, options.root)}`);
  } else {
    lines.push(`  none recorded (${SOURCE_TEXT[full.source] ?? full.source}, ${day(full.confirmedAt ?? full.createdAt)})`);
  }
  if (full.alternatives?.length) {
    lines.push('Rejected alternatives:');
    for (const alternative of full.alternatives) lines.push(`  ${alternative.id} ${alternative.title} — rejected: ${alternative.reason}`);
  }
  if (full.exceptions?.length) {
    lines.push('Exceptions:');
    for (const exception of full.exceptions) {
      const state = exception.revokedAt ? 'revoked' : exception.inForce === false ? 'expired' : exception.expiresAt ? `until ${day(exception.expiresAt)}` : 'no expiry';
      lines.push(`  ${exception.id} ${scopeText(exception.scope)} [${state}] — ${exception.reason}`);
    }
  }
  if (full.conflicts?.length) {
    lines.push('Open conflicts:');
    for (const conflict of full.conflicts) lines.push(`  ${conflictLine(conflict)}`);
  }
  return lines.join('\n');
}

export function conflictLine(conflict) {
  const state = conflict.status === 'pending' ? 'pending' : `${conflict.status}${conflict.resolution ? `: ${conflict.resolution}` : ''}`;
  const seen = conflict.occurrences > 1 ? `, seen ${conflict.occurrences}×` : '';
  return `${conflict.id} [${state}${seen}] ${conflict.decisionId} — ${conflict.description}`;
}

export function historyLine(entry) {
  return `${entry.createdAt.slice(0, 16).replace('T', ' ')}  ${entry.decisionId ?? entry.entityId}  ${entry.action}  (${entry.actor})  ${truncate(entry.summary, 160)}`;
}

const VERDICT_TEXT = {
  compatible: 'COMPATIBLE',
  unknown: 'UNKNOWN — insufficient evidence, needs judgement',
  potential_conflict: 'POTENTIAL CONFLICT',
  confirmed_violation: 'CONFIRMED VIOLATION',
};
export const verdictText = (verdict) => VERDICT_TEXT[verdict] ?? verdict;

function evidenceSummary(ctx, decision) {
  const evidence = ctx.store.evidence.listByDecision(decision.id);
  if (!evidence.length) {
    return `Evidence: none recorded (${SOURCE_TEXT[decision.source] ?? decision.source}, ${day(decision.confirmedAt ?? decision.createdAt)})`;
  }
  return `Evidence: ${evidence.map((e) => `${e.source}${e.locator ? ` (${e.locator})` : ''}`).join('; ')}`;
}

/** One finding, fully anchored: conflict ID, decision ID, rule, reason, evidence, what matched. */
export function findingBlock(ctx, finding) {
  const { decision, constraint } = finding;
  const lines = [];
  lines.push(
    `${finding.conflictId ? `${finding.conflictId} · ` : ''}${verdictText(finding.verdict)} with ${decision.id} "${decision.title}"`,
  );
  lines.push(`  Rule ${constraint.id} (${kindText(constraint.kind)}, ${constraint.severity}): ${constraint.rule}`);
  lines.push(`  Reason: ${truncate(decision.rationale || decision.statement, 400)}`);
  lines.push(`  ${evidenceSummary(ctx, decision)}`);
  if (finding.detector === 'protect') {
    lines.push(`  Detected: ${finding.path} is a protected path.`);
  } else if (finding.detector === 'command') {
    lines.push(`  Detected: command matches /${finding.pattern}/ → ${finding.excerpt}`);
  } else {
    lines.push(`  Detected: ${finding.path}${finding.line ? `:${finding.line}` : ''} matches /${finding.pattern}/ → ${finding.excerpt}`);
  }
  return lines.join('\n');
}

export const RESOLUTION_OPTIONS = [
  'Options to put to the developer (the choice is theirs, not yours):',
  '  1. Keep the decision — change the approach so it complies.',
  '  2. Update the decision — it no longer fits (/intentguard:review, or supersede it).',
  '  3. Allow an explicit exception for this case (recorded with a reason).',
  '  4. Investigate further before deciding.',
].join('\n');

/** Notice injected when a tool call runs into recorded decisions. */
export function conflictNotice(ctx, findings) {
  const lines = ['IntentGuard: this change may conflict with a recorded engineering decision.', ''];
  for (const finding of findings) lines.push(findingBlock(ctx, finding), '');
  lines.push('Do not silently continue past this. Stop, tell the developer what you found (cite the IDs above), and ask how to proceed.');
  lines.push(RESOLUTION_OPTIONS);
  const ids = findings.map((f) => f.conflictId).filter(Boolean);
  if (ids.length) {
    lines.push(
      `If the detector is simply wrong here, say so and record it: \`intentguard resolve ${ids[0]} --as false-positive --note "<why>"\` (it will not be raised again).`,
    );
  }
  return lines.join('\n');
}

/** Just-in-time reminder of decisions governing a file being edited. */
export function governingNotice(ctx, relPath, entries) {
  const lines = [`IntentGuard: ${relPath} is governed by recorded decisions. Make sure this change respects them:`];
  for (const { decision, constraints } of entries) {
    lines.push(`- ${decision.id} "${decision.title}": ${truncate(decision.statement, 300)}`);
    for (const constraint of constraints) lines.push(`    ${kindText(constraint.kind)}: ${constraint.rule} (${constraint.id})`);
    if (decision.rationale) lines.push(`    Why: ${truncate(decision.rationale, 300)}`);
  }
  lines.push('If the change would contradict one of these, stop and raise it with the developer instead of proceeding.');
  return lines.join('\n');
}

/** Context injected when a user prompt touches recorded decisions or rejected ideas. */
export function promptNotice(ctx, matches) {
  const lines = [];
  if (matches.decisions.length) {
    lines.push('IntentGuard: recorded decisions that look relevant to this request:');
    for (const { decision, constraints } of matches.decisions) {
      lines.push(`- ${decision.id} "${decision.title}" (scope: ${scopeText(decision.scope)})`);
      lines.push(`    Decision: ${truncate(decision.statement, 300)}`);
      if (decision.rationale) lines.push(`    Why: ${truncate(decision.rationale, 300)}`);
      for (const constraint of constraints) lines.push(`    ${kindText(constraint.kind)}: ${constraint.rule} (${constraint.id})`);
      lines.push(`    ${evidenceSummary(ctx, decision)}`);
    }
  }
  if (matches.alternatives.length) {
    lines.push('IntentGuard: ideas that were already considered and rejected:');
    for (const { alternative } of matches.alternatives) {
      const link = alternative.decisionId ? ` (see ${alternative.decisionId})` : '';
      lines.push(`- ${alternative.id} "${alternative.title}"${link} — rejected because: ${truncate(alternative.reason, 300)}`);
    }
  }
  if (!lines.length) return '';
  lines.push(
    'Before planning, compare the request with these. If it is compatible, proceed normally. If it would contradict a decision or revive a rejected idea, say so first — cite the ID and its reason — and ask the developer whether to keep the decision, update it, allow an exception, or investigate. Decisions may change, but only deliberately.',
  );
  return lines.join('\n');
}

/** Session-start briefing. */
export function sessionSummary(ctx) {
  const { store, config } = ctx;
  const active = store.decisions.list({ status: 'active' });
  const proposed = store.decisions.list({ status: 'proposed' });
  const rejected = store.alternatives.list({ status: 'rejected' });
  const pending = store.conflicts.countPending();

  if (!active.length && !proposed.length && !rejected.length) {
    const lines = ['IntentGuard is enabled for this project; no engineering decisions are recorded yet.'];
    if (fs.existsSync(path.join(dataDir(ctx.root), EXPORT_FILE))) {
      // A teammate committed shared decisions, but this machine's local store is empty.
      lines.push(
        `A shared decisions file exists (${DATA_DIR}/${EXPORT_FILE}) that has not been imported on this machine. Tell the developer, and if they agree run: intentguard import ${DATA_DIR}/${EXPORT_FILE}`,
      );
    }
    lines.push(
      'When the developer makes a durable decision (architecture, a hard constraint, a rejected approach), offer to record it with /intentguard:remember. Never record a decision without their explicit confirmation.',
    );
    return lines.join('\n');
  }

  const limit = config.context?.sessionDecisions ?? 12;
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const ranked = active
    .map((decision) => {
      const constraints = store.constraints.listByDecision(decision.id);
      const top = Math.min(4, ...constraints.map((c) => severityRank[c.severity] ?? 4));
      return { decision, constraints, top };
    })
    .sort((a, b) => a.top - b.top || a.decision.id.localeCompare(b.decision.id));

  const lines = [
    `IntentGuard: this project has ${active.length} active engineering decision${active.length === 1 ? '' : 's'}. They record what was decided and why. Respect them; if a request conflicts with one, raise it with the developer (citing the ID) instead of silently overriding it.`,
  ];
  for (const { decision, constraints } of ranked.slice(0, limit)) {
    lines.push(`- ${decisionLine(decision)}`);
    for (const constraint of constraints.slice(0, 3)) lines.push(`    ${kindText(constraint.kind)}: ${truncate(constraint.rule, 160)}`);
  }
  if (ranked.length > limit) lines.push(`- …and ${ranked.length - limit} more (\`intentguard list\`).`);
  if (rejected.length) {
    lines.push(
      `Rejected ideas on record (do not re-propose without mentioning the earlier rejection): ${rejected
        .slice(0, 8)
        .map((a) => `${a.id} ${a.title}`)
        .join('; ')}${rejected.length > 8 ? '; …' : ''}`,
    );
  }
  if (pending) lines.push(`Pending conflicts awaiting the developer: ${pending} (/intentguard:conflicts).`);
  if (proposed.length) {
    lines.push(`Proposed decisions awaiting confirmation (not enforced): ${proposed.map((d) => d.id).join(', ')}.`);
  }
  lines.push(
    'Full record of any decision: `intentguard why <ID>`. Record new decisions only after the developer explicitly confirms them (/intentguard:remember).',
  );
  return lines.join('\n');
}

/** Human-readable report for `check`. */
export function formatCheck(ctx, result) {
  const lines = [`IntentGuard check (${result.mode}): ${result.checked} file(s) examined.`, `Verdict: ${verdictText(result.verdict)}`];
  if (result.findings.length) {
    lines.push('', 'Findings:');
    for (const finding of result.findings) lines.push(findingBlock(ctx, finding), '');
    lines.push(RESOLUTION_OPTIONS);
  }
  if (result.needsJudgement.length) {
    lines.push('', 'Decisions governing the changed files that cannot be checked mechanically — review the change against them:');
    for (const { decision, constraints, files } of result.needsJudgement) {
      lines.push(`- ${decision.id} "${decision.title}": ${truncate(decision.statement, 300)}`);
      for (const constraint of constraints.filter((c) => !c.protect && !c.patterns.length)) {
        lines.push(`    ${kindText(constraint.kind)}: ${constraint.rule} (${constraint.id})`);
      }
      lines.push(`    files: ${files.slice(0, 8).join(', ')}${files.length > 8 ? `, … (+${files.length - 8})` : ''}`);
    }
  }
  if (result.excepted.length) {
    lines.push('', 'Covered by explicit exceptions:');
    for (const entry of result.excepted) lines.push(`- ${entry.path}: ${entry.exception.id} for ${entry.decision.id} — ${entry.exception.reason}`);
  }
  if (result.suppressed.length) {
    lines.push('', `${result.suppressed.length} finding(s) hidden because they were dismissed as false positives.`);
  }
  if (result.verdict === 'compatible') lines.push('', 'No recorded decision is affected by these changes.');
  return lines.join('\n');
}

/** Human-readable report for `review`. */
export function formatReview(result) {
  const lines = [`IntentGuard review: ${result.reviewed} active decision(s) examined.`];
  if (!result.items.length) lines.push('No drift signals found.');
  for (const { decision, signals } of result.items) {
    lines.push('', decisionLine(decision));
    for (const signal of signals) lines.push(`  [${signal.level}] ${signal.code}: ${signal.message}`);
  }
  if (result.proposed.length) {
    lines.push('', 'Proposed decisions awaiting the developer (confirm or deprecate):');
    for (const decision of result.proposed) lines.push(`  ${decisionLine(decision)}`);
  }
  if (result.expiredExceptions.length) {
    lines.push('', 'Expired exceptions (the code they covered is checked again):');
    for (const exception of result.expiredExceptions) {
      lines.push(`  ${exception.id} for ${exception.decisionId} expired ${day(exception.expiresAt)} — ${exception.reason}`);
    }
  }
  if (result.items.length) {
    lines.push(
      '',
      'For each flagged decision the developer chooses: keep it (`intentguard review --keep <ID>`), update it (`intentguard update` / `supersede`), or retire it (`intentguard deprecate <ID>`).',
    );
  }
  return lines.join('\n');
}
