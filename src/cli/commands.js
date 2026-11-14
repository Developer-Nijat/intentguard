import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkWorkspace } from '../core/check.js';
import { evaluateFile, verdictAtLeast } from '../core/conflict-engine.js';
import { openContext } from '../core/context.js';
import {
  addConstraint,
  addEvidence,
  confirmDecision,
  deprecateDecision,
  getDecision,
  grantException,
  markReviewed,
  reactivateDecision,
  recordDecision,
  rejectAlternative,
  removeConstraint,
  requireDecision,
  resolveConflict,
  reverifyEvidence,
  revokeException,
  supersedeDecision,
  updateDecision,
} from '../core/decision-engine.js';
import { reviewDecisions } from '../core/drift.js';
import {
  DATA_DIR,
  EXPORT_FILE,
  dataDir,
  dbPath,
  findGitRoot,
  findProjectRoot,
  initProjectFiles,
  toRelative,
} from '../core/project.js';
import { findRelevant } from '../core/relevance.js';
import { exportData, importData } from '../core/transfer.js';
import {
  DECISION_STATUSES,
  ENFORCEMENTS,
  NotFoundError,
  VERDICTS,
  ValidationError,
  validateEnum,
} from '../core/validation.js';
import { SCHEMA_VERSION } from '../storage/migrations.js';
import { canonicalId } from '../storage/store.js';
import { isInForce } from '../storage/repositories/exceptions.js';
import {
  conflictLine,
  constraintLine,
  decisionLine,
  formatCheck,
  formatDecision,
  formatReview,
  historyLine,
  promptNotice,
  verdictText,
} from './format.js';
import { EXIT, UsageError, requireRoot } from './index.js';

const COMMON = {
  json: { type: 'boolean' },
  project: { type: 'string' },
  actor: { type: 'string' },
  session: { type: 'string' },
};
const many = { type: 'string', multiple: true };
const one = { type: 'string' };
const flag = { type: 'boolean' };

function parse(args, options = {}) {
  return parseArgs({ args, options: { ...COMMON, ...options }, allowPositionals: true, strict: true });
}

/** Open the project, run `fn`, always close the database. */
function withProject(env, values, fn) {
  const root = requireRoot(env.cwd, values.project);
  const ctx = openContext(root);
  try {
    return fn(ctx);
  } finally {
    ctx.close();
  }
}

const metaOf = (values, extra = {}) => ({ actor: values.actor ?? 'developer', sessionId: values.session, ...extra });

function emit(env, values, data, text) {
  env.out(values.json ? JSON.stringify(data, null, 2) : text);
}

/** Read JSON from a file or stdin ("-"). Tolerates the UTF-8 BOM PowerShell likes to add. */
function readJsonInput(env, source) {
  let raw;
  try {
    raw = source === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(env.cwd, source), 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${source === '-' ? 'stdin' : source}: ${error.message}`);
  }
  try {
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch (error) {
    throw new UsageError(`${source === '-' ? 'stdin' : source} is not valid JSON: ${error.message}`);
  }
}

const DECISION_FLAGS = {
  input: one,
  title: one,
  decision: one,
  reason: one,
  type: one,
  source: one,
  scope: many,
  keyword: many,
  'must-not': many,
  must: many,
  evidence: many,
  severity: one,
  enforcement: one,
  pattern: many,
  'command-pattern': many,
  protect: flag,
  confirmed: flag,
  note: one,
};

/** Merge `--input` JSON with individual flags into one decision payload. */
function decisionPayload(env, values) {
  const payload = values.input ? readJsonInput(env, values.input) : {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new UsageError('--input must contain a JSON object describing one decision');
  }
  for (const [flagName, field] of [
    ['title', 'title'],
    ['decision', 'decision'],
    ['reason', 'reason'],
    ['type', 'type'],
    ['source', 'source'],
  ]) {
    if (values[flagName] !== undefined) payload[field] = values[flagName];
  }
  if (values.scope) payload.scope = values.scope;
  if (values.keyword) payload.keywords = values.keyword;
  if (values.evidence) payload.evidence = [...(payload.evidence ?? []), ...values.evidence];

  const rules = [
    ...(values['must-not'] ?? []).map((rule) => ({ rule, kind: 'must_not' })),
    ...(values.must ?? []).map((rule) => ({ rule, kind: 'must' })),
  ];
  const detectors = values.pattern || values['command-pattern'] || values.protect;
  if (detectors && !rules.length) {
    if (!values.protect) throw new UsageError('--pattern/--command-pattern need a rule: add --must-not "<rule>"');
    rules.push({ rule: 'Do not modify files in this scope', kind: 'must_not' });
  }
  if (detectors && rules.length > 1) {
    throw new UsageError('--pattern/--command-pattern/--protect apply to a single rule; for several rules with detectors use --input JSON');
  }
  for (const rule of rules) {
    if (values.severity) rule.severity = values.severity;
    if (values.enforcement) rule.enforcement = values.enforcement;
    if (values.pattern) rule.patterns = values.pattern;
    if (values['command-pattern']) rule.commandPatterns = values['command-pattern'];
    if (values.protect) rule.protect = true;
  }
  if (rules.length) payload.constraints = [...(Array.isArray(payload.constraints) ? payload.constraints : []), ...rules];
  return payload;
}

const savedNote = (decision) =>
  decision.status === 'active'
    ? `Recorded ${decision.id} (active).`
    : `Saved ${decision.id} as PROPOSED — it is not enforced until the developer confirms it: intentguard confirm ${decision.id}`;

/* ------------------------------------------------------------------ setup */

function init(env) {
  const { values } = parse(env.args, { enforcement: one });
  const overrides = {};
  if (values.enforcement) overrides.enforcement = validateEnum(values.enforcement, ENFORCEMENTS, '--enforcement');
  const start = values.project ? path.resolve(env.cwd, values.project) : env.cwd;
  const root = findProjectRoot(start) ?? findGitRoot(start) ?? start;
  const { created } = initProjectFiles(root, overrides);
  const ctx = openContext(root);
  try {
    const counts = ctx.store.decisions.countByStatus();
    const data = { root, dataDir: dataDir(root), created, enforcement: ctx.config.enforcement, decisions: counts };
    emit(
      env,
      values,
      data,
      [
        `${created ? 'IntentGuard initialised' : 'IntentGuard already initialised'} in ${dataDir(root)}`,
        `Enforcement mode: ${ctx.config.enforcement} (observe | warn | enforce — change in ${DATA_DIR}/config.json)`,
        `Decisions on record: ${Object.values(counts).reduce((a, b) => a + b, 0)}`,
        'All data stays on this machine. The database is git-ignored; use `intentguard export` to share decisions.',
        'Next: record your first decision with /intentguard:remember.',
      ].join('\n'),
    );
  } finally {
    ctx.close();
  }
}

function status(env) {
  const { values } = parse(env.args);
  return withProject(env, values, (ctx) => {
    const counts = ctx.store.decisions.countByStatus();
    const data = {
      root: ctx.root,
      database: dbPath(ctx.root),
      schemaVersion: SCHEMA_VERSION,
      enforcement: ctx.config.enforcement,
      decisions: counts,
      constraints: ctx.store.constraints.listActive().length,
      rejectedIdeas: ctx.store.alternatives.list({ status: 'rejected' }).length,
      pendingConflicts: ctx.store.conflicts.countPending(),
      exceptionsInForce: ctx.store.exceptions.listInForce(new Date().toISOString()).length,
    };
    emit(
      env,
      values,
      data,
      [
        `Project: ${data.root}`,
        `Enforcement: ${data.enforcement}`,
        `Decisions: ${DECISION_STATUSES.map((s) => `${counts[s] ?? 0} ${s}`).join(', ')}`,
        `Active constraints: ${data.constraints} · Rejected ideas: ${data.rejectedIdeas}`,
        `Pending conflicts: ${data.pendingConflicts} · Exceptions in force: ${data.exceptionsInForce}`,
        `Database: ${data.database} (schema v${data.schemaVersion}, local only)`,
      ].join('\n'),
    );
  });
}

/* -------------------------------------------------------------- decisions */

function add(env) {
  const { values } = parse(env.args, DECISION_FLAGS);
  return withProject(env, values, (ctx) => {
    const decision = recordDecision(ctx, decisionPayload(env, values), metaOf(values, { confirmed: values.confirmed === true }));
    emit(env, values, decision, `${savedNote(decision)}\n\n${formatDecision(decision, { root: ctx.root, defaultEnforcement: ctx.config.enforcement })}`);
  });
}

function confirm(env) {
  const { values, positionals } = parse(env.args, { note: one });
  if (!positionals.length) throw new UsageError('usage: intentguard confirm <DEC>...');
  return withProject(env, values, (ctx) => {
    const confirmed = positionals.map((id) => confirmDecision(ctx, id, metaOf(values, { note: values.note })));
    emit(env, values, confirmed, confirmed.map((d) => `Confirmed ${d.id}: ${d.title} — now active.`).join('\n'));
  });
}

function list(env) {
  const { values } = parse(env.args, { status: one, type: one, path: one });
  return withProject(env, values, (ctx) => {
    let statuses = ['active', 'proposed'];
    if (values.status === 'all') statuses = DECISION_STATUSES;
    else if (values.status) statuses = [validateEnum(values.status, DECISION_STATUSES, '--status')];
    let decisions = ctx.store.decisions.list({ status: statuses, type: values.type });
    if (values.path) {
      const rel = toRelative(ctx.root, values.path, env.cwd);
      if (!rel) throw new UsageError(`"${values.path}" is outside the project`);
      const governing = new Set(evaluateFile(ctx, { path: rel }).governing.map((g) => g.decision.id));
      decisions = decisions.filter((d) => governing.has(d.id));
    }
    const lines = decisions.map((decision) => {
      const constraints = ctx.store.constraints.listByDecision(decision.id);
      return [decisionLine(decision), ...constraints.map((c) => `    ${constraintLine(c, ctx.config.enforcement)}`)].join('\n');
    });
    emit(env, values, decisions, lines.length ? lines.join('\n') : 'No decisions recorded for this filter.');
  });
}

function showAlternative(alternative) {
  return [
    `${alternative.id} · Rejected idea: ${alternative.title}`,
    alternative.description ? `Idea: ${alternative.description}` : null,
    `Rejected because: ${alternative.reason}`,
    alternative.decisionId ? `Related decision: ${alternative.decisionId}` : null,
    `Recorded: ${alternative.createdAt.slice(0, 10)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function why(env) {
  const { values, positionals } = parse(env.args);
  if (!positionals.length) throw new UsageError('usage: intentguard why <ID | file path | free text>');
  return withProject(env, values, (ctx) => {
    const render = (id) => formatDecision(getDecision(ctx, id), { root: ctx.root, defaultEnforcement: ctx.config.enforcement });
    const query = positionals.join(' ');
    const idMatch = positionals.length === 1 ? /^([a-z]+)-?\d+$/i.exec(query) : null;

    if (idMatch) {
      const prefix = idMatch[1].toUpperCase();
      const id = canonicalId(query);
      if (prefix === 'DEC') return emit(env, values, getDecision(ctx, id), render(id));
      const lookups = {
        CON: () => ctx.store.constraints.get(id),
        CONF: () => ctx.store.conflicts.get(id),
        EXC: () => ctx.store.exceptions.get(id),
        EVD: () => ctx.store.evidence.get(id),
        ALT: () => ctx.store.alternatives.get(id),
      };
      const record = lookups[prefix]?.();
      if (!record) throw new NotFoundError('Record', query);
      const parts = [];
      if (prefix === 'ALT') parts.push(showAlternative(record));
      if (prefix === 'CONF') parts.push(conflictLine(record), record.excerpt ? `  → ${record.excerpt}` : '');
      if (prefix === 'EXC') parts.push(`${record.id} exception for ${record.decisionId}: ${record.reason}`);
      if (record.decisionId) parts.push(render(record.decisionId));
      return emit(env, values, record, parts.filter(Boolean).join('\n\n'));
    }

    const looksLikePath = positionals.length === 1 && (/[\\/]/.test(query) || fs.existsSync(path.resolve(env.cwd, query)));
    if (looksLikePath) {
      const rel = toRelative(ctx.root, query, env.cwd);
      if (!rel) throw new UsageError(`"${query}" is outside the project`);
      const { governing } = evaluateFile(ctx, { path: rel });
      return emit(
        env,
        values,
        governing.map((g) => getDecision(ctx, g.decision.id)),
        governing.length
          ? `Decisions governing ${rel}:\n\n${governing.map((g) => render(g.decision.id)).join('\n\n')}`
          : `No recorded decision governs ${rel}.`,
      );
    }

    const matches = findRelevant(ctx, query, { limit: 5, statuses: ['active', 'proposed'] });
    const parts = matches.decisions.map(({ decision }) => render(decision.id));
    for (const { alternative } of matches.alternatives) parts.push(showAlternative(alternative));
    emit(
      env,
      values,
      { decisions: matches.decisions.map((m) => getDecision(ctx, m.decision.id)), rejectedIdeas: matches.alternatives.map((m) => m.alternative) },
      parts.length ? parts.join('\n\n') : `No recorded decision or rejected idea matches "${query}".`,
    );
  });
}

function update(env) {
  const { values, positionals } = parse(env.args, DECISION_FLAGS);
  if (positionals.length !== 1) throw new UsageError('usage: intentguard update <DEC> [--title ..] [--decision ..] [--reason ..] [--scope ..]');
  if (values.confirmed) throw new UsageError('use `intentguard confirm <DEC>` to confirm a proposed decision');
  return withProject(env, values, (ctx) => {
    const decision = updateDecision(ctx, positionals[0], decisionPayload(env, values), metaOf(values, { note: values.note }));
    emit(env, values, decision, `Updated ${decision.id} (revision ${decision.revision}).\n\n${formatDecision(decision, { root: ctx.root, defaultEnforcement: ctx.config.enforcement })}`);
  });
}

function supersede(env) {
  const { values, positionals } = parse(env.args, DECISION_FLAGS);
  if (positionals.length !== 1) throw new UsageError('usage: intentguard supersede <DEC> --input <file.json|-> [--confirmed]');
  return withProject(env, values, (ctx) => {
    const result = supersedeDecision(
      ctx,
      positionals[0],
      decisionPayload(env, values),
      metaOf(values, { confirmed: values.confirmed === true, note: values.note }),
    );
    emit(
      env,
      values,
      result,
      `${result.previous.id} is now superseded by ${result.next.id}.\n${savedNote(result.next)}\n\n${formatDecision(result.next, { root: ctx.root, defaultEnforcement: ctx.config.enforcement })}`,
    );
  });
}

const statusChange = (fn, verb) => (env) => {
  const { values, positionals } = parse(env.args, { note: one });
  if (positionals.length !== 1) throw new UsageError(`usage: intentguard ${verb} <DEC> [--note ..]`);
  return withProject(env, values, (ctx) => {
    const decision = fn(ctx, positionals[0], metaOf(values, { note: values.note }));
    emit(env, values, decision, `${decision.id} is now ${decision.status}: ${decision.title}`);
  });
};

/* ----------------------------------------- constraints, evidence, rejected */

function constraint(env) {
  const [action, ...args] = env.args;
  const { values, positionals } = parse(args, {
    rule: one,
    kind: one,
    severity: one,
    enforcement: one,
    scope: many,
    pattern: many,
    'command-pattern': many,
    protect: flag,
    note: one,
  });
  return withProject(env, values, (ctx) => {
    if (action === 'add') {
      if (positionals.length !== 1) throw new UsageError('usage: intentguard constraint add <DEC> --rule "<rule>" [options]');
      const created = addConstraint(
        ctx,
        positionals[0],
        {
          rule: values.rule,
          kind: values.kind,
          severity: values.severity,
          enforcement: values.enforcement,
          scope: values.scope,
          patterns: values.pattern,
          commandPatterns: values['command-pattern'],
          protect: values.protect === true,
        },
        metaOf(values),
      );
      return emit(env, values, created, `Added ${constraintLine(created, ctx.config.enforcement)} to ${created.decisionId}.`);
    }
    if (action === 'remove') {
      if (positionals.length !== 1) throw new UsageError('usage: intentguard constraint remove <CON>');
      const removed = removeConstraint(ctx, positionals[0], metaOf(values, { note: values.note }));
      return emit(env, values, removed, `Removed ${removed.id} from ${removed.decisionId}.`);
    }
    throw new UsageError('usage: intentguard constraint add|remove ...');
  });
}

function evidence(env) {
  const [action, ...args] = env.args;
  const { values, positionals } = parse(args, { source: one, kind: one, locator: one, description: one });
  if (action !== 'add' || positionals.length !== 1) {
    throw new UsageError('usage: intentguard evidence add <DEC> --source <path|url|sha> [--locator ..] [--description ..]');
  }
  return withProject(env, values, (ctx) => {
    const created = addEvidence(
      ctx,
      positionals[0],
      { source: values.source, kind: values.kind, locator: values.locator, description: values.description },
      metaOf(values),
    );
    const warning = created.kind === 'file' && !created.verifiedAt ? '\nNote: that file does not exist in the project, so the evidence could not be verified.' : '';
    emit(env, values, created, `Added evidence ${created.id} (${created.kind}: ${created.source}) to ${created.decisionId}.${warning}`);
  });
}

function reject(env) {
  const { values } = parse(env.args, { title: one, reason: one, description: one, decision: one, keyword: many, input: one });
  return withProject(env, values, (ctx) => {
    const payload = values.input ? readJsonInput(env, values.input) : {};
    if (values.title) payload.title = values.title;
    if (values.reason) payload.reason = values.reason;
    if (values.description) payload.description = values.description;
    if (values.keyword) payload.keywords = values.keyword;
    const created = rejectAlternative(ctx, payload, metaOf(values, { decisionId: values.decision ?? payload.decisionId }));
    emit(env, values, created, `Remembered rejected idea ${created.id}: ${created.title}\nRejected because: ${created.reason}`);
  });
}

function rejected(env) {
  const { values } = parse(env.args);
  return withProject(env, values, (ctx) => {
    const ideas = ctx.store.alternatives.list({ status: 'rejected' });
    emit(
      env,
      values,
      ideas,
      ideas.length
        ? ideas.map((a) => `${a.id} ${a.title}${a.decisionId ? ` (${a.decisionId})` : ''} — rejected: ${a.reason}`).join('\n')
        : 'No rejected ideas recorded.',
    );
  });
}

/* ----------------------------------------------------------- verification */

function check(env) {
  const { values, positionals } = parse(env.args, {
    staged: flag,
    base: one,
    plan: one,
    'dry-run': flag,
    'fail-on': one,
  });
  const failOn = values['fail-on'] ? validateEnum(values['fail-on'], VERDICTS, '--fail-on') : null;
  return withProject(env, values, (ctx) => {
    if (values.plan !== undefined) {
      const matches = findRelevant(ctx, values.plan, { limit: 8 });
      const verdict = matches.decisions.length || matches.alternatives.length ? 'unknown' : 'compatible';
      const text =
        verdict === 'compatible'
          ? `Verdict: ${verdictText('compatible')}\nNo recorded decision or rejected idea appears related to this plan.`
          : `Verdict: ${verdictText('unknown')}\nKeyword matching cannot judge intent. Compare the plan with these records and classify it as compatible, potential conflict, or confirmed violation:\n\n${promptNotice(ctx, matches)}`;
      emit(env, values, { verdict, ...matches }, text);
      return failOn && verdictAtLeast(verdict, failOn) ? EXIT.failed : EXIT.ok;
    }
    const result = checkWorkspace(ctx, {
      files: positionals,
      cwd: env.cwd,
      staged: values.staged === true,
      base: values.base,
      record: values['dry-run'] !== true,
      sessionId: values.session,
    });
    emit(env, values, result, formatCheck(ctx, result));
    return failOn && verdictAtLeast(result.verdict, failOn) ? EXIT.failed : EXIT.ok;
  });
}

function conflicts(env) {
  const { values } = parse(env.args, { status: one });
  return withProject(env, values, (ctx) => {
    const wanted = values.status ?? 'pending';
    const items = ctx.store.conflicts.list(wanted === 'all' ? {} : { status: wanted });
    const lines = [];
    for (const conflict of items) {
      const decision = ctx.store.decisions.get(conflict.decisionId);
      lines.push(conflictLine(conflict));
      lines.push(`    decision: "${decision?.title ?? '?'}" · confidence ${conflict.confidence} · detected by ${conflict.detectedBy} · last seen ${conflict.lastSeenAt.slice(0, 10)}`);
      if (conflict.excerpt) lines.push(`    → ${conflict.excerpt}`);
      if (conflict.note) lines.push(`    note: ${conflict.note}`);
    }
    if (items.some((c) => c.status === 'pending')) {
      lines.push('', 'Resolve with: intentguard resolve <CONF> --as kept|updated|exception|false-positive [--note "<why>"]');
    }
    emit(env, values, items, items.length ? lines.join('\n') : `No ${wanted === 'all' ? '' : `${wanted} `}conflicts.`);
  });
}

const RESOLUTION_ALIASES = {
  kept: 'kept',
  keep: 'kept',
  updated: 'decision_updated',
  update: 'decision_updated',
  decision_updated: 'decision_updated',
  exception: 'exception_granted',
  exception_granted: 'exception_granted',
  'false-positive': 'false_positive',
  false_positive: 'false_positive',
};

function resolve(env) {
  const { values, positionals } = parse(env.args, { as: one, note: one, scope: many, expires: one });
  if (positionals.length !== 1 || !values.as) {
    throw new UsageError('usage: intentguard resolve <CONF> --as kept|updated|exception|false-positive [--note ..]');
  }
  const resolution = RESOLUTION_ALIASES[values.as.toLowerCase()];
  if (!resolution) throw new UsageError(`--as must be one of: kept, updated, exception, false-positive (got "${values.as}")`);
  if (resolution === 'exception_granted' && !values.note) {
    throw new UsageError('an exception needs a reason: add --note "<why this case is allowed>"');
  }
  return withProject(env, values, (ctx) => {
    const result = resolveConflict(
      ctx,
      positionals[0],
      resolution,
      metaOf(values, { note: values.note, scope: values.scope, expires: values.expires }),
    );
    const extra = result.exception ? `\nGranted ${result.exception.id} (scope: ${result.exception.scope.join(', ') || 'whole decision'}).` : '';
    const hint = resolution === 'decision_updated' ? '\nRemember to change the decision itself: intentguard update / supersede / deprecate.' : '';
    emit(env, values, result, `${result.conflict.id} ${result.conflict.status} (${resolution}).${extra}${hint}`);
  });
}

function exception(env) {
  const [action, ...args] = env.args;
  const { values, positionals } = parse(args, { reason: one, scope: many, constraint: one, expires: one, note: one });
  return withProject(env, values, (ctx) => {
    if (action === 'add') {
      if (positionals.length !== 1) throw new UsageError('usage: intentguard exception add <DEC> --reason "<why>" [--scope G]... [--expires DATE]');
      const created = grantException(
        ctx,
        positionals[0],
        { reason: values.reason, scope: values.scope, constraintId: values.constraint, expires: values.expires },
        metaOf(values),
      );
      return emit(
        env,
        values,
        created,
        `Granted ${created.id} for ${created.decisionId} (scope: ${created.scope.join(', ') || 'whole decision'}${created.expiresAt ? `, until ${created.expiresAt.slice(0, 10)}` : ''}).`,
      );
    }
    if (action === 'revoke') {
      if (positionals.length !== 1) throw new UsageError('usage: intentguard exception revoke <EXC>');
      const revoked = revokeException(ctx, positionals[0], metaOf(values, { note: values.note }));
      return emit(env, values, revoked, `Revoked ${revoked.id}; ${revoked.decisionId} applies there again.`);
    }
    if (action === 'list' || action === undefined) {
      const now = new Date().toISOString();
      const items = ctx.store.exceptions.list().map((e) => ({ ...e, inForce: isInForce(e, now) }));
      return emit(
        env,
        values,
        items,
        items.length
          ? items
              .map((e) => `${e.id} ${e.decisionId} [${e.revokedAt ? 'revoked' : e.inForce ? 'in force' : 'expired'}] ${e.scope.join(', ') || 'whole decision'} — ${e.reason}`)
              .join('\n')
          : 'No exceptions recorded.',
      );
    }
    throw new UsageError('usage: intentguard exception add|list|revoke ...');
  });
}

function review(env) {
  const { values } = parse(env.args, { keep: many, note: one });
  return withProject(env, values, (ctx) => {
    if (values.keep?.length) {
      const kept = values.keep.map((id) => {
        reverifyEvidence(ctx, id, metaOf(values));
        return markReviewed(ctx, id, metaOf(values, { note: values.note }));
      });
      return emit(env, values, kept, kept.map((d) => `${d.id} reviewed and kept; evidence re-verified.`).join('\n'));
    }
    const result = reviewDecisions(ctx);
    emit(env, values, result, formatReview(result));
  });
}

function history(env) {
  const { values, positionals } = parse(env.args, { limit: one });
  return withProject(env, values, (ctx) => {
    const filter = { limit: values.limit ? Number.parseInt(values.limit, 10) : 50 };
    if (positionals[0]) filter.decisionId = requireDecision(ctx, positionals[0]).id;
    const entries = ctx.store.history.list(filter);
    emit(env, values, entries, entries.length ? entries.map(historyLine).join('\n') : 'No history yet.');
  });
}

/* ------------------------------------------------------------------- data */

function exportCommand(env) {
  const { values } = parse(env.args, { out: one, stdout: flag, full: flag });
  return withProject(env, values, (ctx) => {
    const document = exportData(ctx, { full: values.full === true });
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (values.stdout) return env.out(serialized.trimEnd());
    const target = values.out ? path.resolve(env.cwd, values.out) : path.join(dataDir(ctx.root), EXPORT_FILE);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serialized);
    emit(env, values, { file: target, decisions: document.decisions.length }, `Exported ${document.decisions.length} decision(s) to ${target}`);
  });
}

function importCommand(env) {
  const { values, positionals } = parse(env.args);
  if (positionals.length !== 1) throw new UsageError('usage: intentguard import <file.json>');
  return withProject(env, values, (ctx) => {
    const report = importData(ctx, readJsonInput(env, positionals[0]), metaOf(values));
    const lines = [`Imported ${report.imported.length} decision(s)${report.imported.length ? `: ${report.imported.join(', ')}` : ''}.`];
    if (report.rejectedIdeas) lines.push(`Imported ${report.rejectedIdeas} rejected idea(s).`);
    for (const skipped of report.skipped) lines.push(`Skipped ${skipped.id}: ${skipped.reason}.`);
    emit(env, values, report, lines.join('\n'));
  });
}

function purge(env) {
  const { values } = parse(env.args, { yes: flag });
  const root = requireRoot(env.cwd, values.project);
  if (!values.yes) {
    throw new UsageError(`this permanently deletes every decision in ${dataDir(root)}. Re-run with --yes to confirm (consider \`intentguard export\` first).`);
  }
  fs.rmSync(dataDir(root), { recursive: true, force: true });
  emit(env, values, { deleted: dataDir(root) }, `Deleted ${dataDir(root)}. IntentGuard holds no data for this project any more.`);
}

export const COMMANDS = {
  init,
  status,
  add,
  remember: add,
  confirm,
  list,
  why,
  show: why,
  update,
  supersede,
  deprecate: statusChange(deprecateDecision, 'deprecate'),
  reactivate: statusChange(reactivateDecision, 'reactivate'),
  constraint,
  evidence,
  reject,
  rejected,
  check,
  conflicts,
  resolve,
  exception,
  review,
  history,
  export: exportCommand,
  import: importCommand,
  purge,
};
