/**
 * Decision drift detection: decisions age. This module looks for signs that a
 * recorded decision no longer matches reality, so it can be consciously
 * re-affirmed, updated, or retired — instead of silently rotting.
 */
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../storage/repositories/util.js';
import { readTextFile } from './check.js';
import { resolveEvidence } from './evidence-resolver.js';
import { listFiles } from './git.js';
import { DATA_DIR } from './project.js';
import { matchesScope, normalizePath } from './scope-matcher.js';
import { compilePattern } from './validation.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', DATA_DIR, 'dist', 'build', 'out', 'target', 'vendor', '.next', '.venv', '__pycache__', 'coverage']);
const MAX_FILES = 20000;
const MAX_SCANNED_PER_CONSTRAINT = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

function walk(root) {
  const files = [];
  const stack = [''];
  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(rel);
      } else if (entry.isFile()) {
        files.push(rel);
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files;
}

/** Project files (git-aware when possible), relative, forward-slashed. */
export function listProjectFiles(root) {
  const fromGit = listFiles(root);
  const files = (fromGit ?? walk(root)).map(normalizePath);
  return files.filter((file) => !file.startsWith(`${DATA_DIR}/`)).slice(0, MAX_FILES);
}

function scanForViolations(root, files, decision, constraint, exceptions, cache) {
  const patterns = [];
  for (const source of constraint.patterns) {
    try {
      patterns.push(compilePattern(source));
    } catch {
      /* skip invalid stored pattern */
    }
  }
  if (!patterns.length) return [];
  const scope = constraint.scope ?? decision.scope;
  const hits = [];
  let scanned = 0;
  for (const file of files) {
    if (!matchesScope(file, scope)) continue;
    const excepted = exceptions.some(
      (e) => e.decisionId === decision.id && (!e.constraintId || e.constraintId === constraint.id) && matchesScope(file, e.scope),
    );
    if (excepted) continue;
    if (++scanned > MAX_SCANNED_PER_CONSTRAINT) break;
    if (!cache.has(file)) cache.set(file, readTextFile(root, file));
    const text = cache.get(file);
    if (text && patterns.some((pattern) => pattern.test(text))) hits.push(file);
  }
  return hits;
}

/**
 * Review every active decision for drift signals.
 * @returns {{ items: { decision: object, signals: object[] }[], proposed: object[], expiredExceptions: object[], reviewed: number }}
 */
export function reviewDecisions(ctx, options = {}) {
  const now = options.now ?? nowIso();
  const nowMs = new Date(now).getTime();
  const staleAfterDays = ctx.config.review?.staleAfterDays ?? 180;
  const files = options.files ?? listProjectFiles(ctx.root);
  const exceptionsInForce = ctx.store.exceptions.listInForce(now);
  const cache = new Map();
  const items = [];

  const decisions = ctx.store.decisions.list({ status: 'active' });
  for (const decision of decisions) {
    const signals = [];
    const constraints = ctx.store.constraints.listByDecision(decision.id);

    for (const evidence of ctx.store.evidence.listByDecision(decision.id)) {
      const { state } = resolveEvidence(ctx.root, evidence);
      if (state === 'missing') {
        signals.push({
          code: 'evidence_missing',
          level: 'high',
          message: `Evidence ${evidence.id} (${evidence.source}) no longer exists.`,
        });
      } else if (state === 'changed') {
        signals.push({
          code: 'evidence_changed',
          level: 'medium',
          message: `Evidence ${evidence.id} (${evidence.source}) changed since it was verified on ${evidence.verifiedAt?.slice(0, 10)}. Re-read it and confirm the decision still holds.`,
        });
      }
    }

    if (decision.scope.length && files.length && !files.some((file) => matchesScope(file, decision.scope))) {
      signals.push({
        code: 'scope_empty',
        level: 'medium',
        message: `No file in the project matches the scope (${decision.scope.join(', ')}). The code it governed may have moved or been removed.`,
      });
    }

    for (const constraint of constraints) {
      const hits = scanForViolations(ctx.root, files, decision, constraint, exceptionsInForce, cache);
      if (hits.length) {
        signals.push({
          code: 'violated_in_code',
          level: 'high',
          message: `${constraint.id} is already contradicted by ${hits.length} file(s) in the codebase: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', …' : ''}. Either the code drifted or the decision is out of date.`,
          files: hits.slice(0, 20),
          constraintId: constraint.id,
        });
      }
    }

    const conflicts = ctx.store.conflicts.list({ decisionId: decision.id });
    const recurring = conflicts.filter((c) => c.status !== 'dismissed').reduce((sum, c) => sum + c.occurrences, 0);
    if (recurring >= 3) {
      signals.push({
        code: 'repeated_conflicts',
        level: 'medium',
        message: `Work has run into this decision ${recurring} times. If it keeps getting in the way, it may need to change.`,
      });
    }

    const inForce = exceptionsInForce.filter((e) => e.decisionId === decision.id);
    if (inForce.length >= 2) {
      signals.push({
        code: 'many_exceptions',
        level: 'medium',
        message: `${inForce.length} exceptions are in force (${inForce.map((e) => e.id).join(', ')}). A rule with many exceptions may no longer be the real rule.`,
      });
    }

    const lastLooked = decision.reviewedAt ?? decision.confirmedAt ?? decision.createdAt;
    const ageDays = Math.floor((nowMs - new Date(lastLooked).getTime()) / DAY_MS);
    if (ageDays >= staleAfterDays) {
      signals.push({
        code: 'stale',
        level: 'low',
        message: `Not reviewed for ${ageDays} days (threshold ${staleAfterDays}).`,
      });
    }

    if (signals.length) items.push({ decision, signals });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  const top = (item) => Math.min(...item.signals.map((signal) => rank[signal.level]));
  items.sort((a, b) => top(a) - top(b) || a.decision.id.localeCompare(b.decision.id));

  const expiredExceptions = ctx.store.exceptions
    .list()
    .filter((e) => !e.revokedAt && e.expiresAt && e.expiresAt <= now);

  return {
    items,
    proposed: ctx.store.decisions.list({ status: 'proposed' }),
    expiredExceptions,
    reviewed: decisions.length,
  };
}
