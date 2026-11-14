/**
 * Workspace check: compare the current changes (or an explicit list of files)
 * with the active decisions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { evaluateFile, loadRules, recordFindings, worstVerdict } from './conflict-engine.js';
import { addedSegments, changedFiles } from './git.js';
import { DATA_DIR, toRelative } from './project.js';
import { ValidationError } from './validation.js';

const MAX_FILE_BYTES = 1024 * 1024;

/** Read a project file as text; null when missing, too large, or binary. */
export function readTextFile(root, relPath) {
  try {
    const absolute = path.join(root, relPath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const text = fs.readFileSync(absolute, 'utf8');
    return text.slice(0, 8000).includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

const wholeFile = (root, relPath) => {
  const text = readTextFile(root, relPath);
  return text === null ? [] : [{ startLine: 1, text }];
};

/**
 * @param {object} ctx
 * @param {{ files?: string[], cwd?: string, staged?: boolean, base?: string,
 *           record?: boolean, sessionId?: string, detectedBy?: string }} [options]
 */
export function checkWorkspace(ctx, options = {}) {
  let changes;
  let mode;
  if (options.files?.length) {
    mode = 'files';
    changes = [];
    for (const file of options.files) {
      const rel = toRelative(ctx.root, file, options.cwd ?? ctx.root);
      if (!rel) throw new ValidationError(`"${file}" is outside the project (${ctx.root})`);
      changes.push({ path: rel, status: fs.existsSync(path.join(ctx.root, rel)) ? 'modified' : 'deleted', whole: true });
    }
  } else {
    mode = options.staged ? 'staged' : options.base ? `diff against ${options.base}` : 'working tree';
    changes = changedFiles(ctx.root, options);
    if (changes === null) {
      throw new ValidationError('This project is not a git repository. Pass the files to check explicitly: intentguard check <file...>');
    }
  }
  changes = changes.filter((change) => change.path !== DATA_DIR && !change.path.startsWith(`${DATA_DIR}/`));

  const rules = loadRules(ctx);
  const results = [];
  for (const change of changes) {
    let segments = [];
    if (change.status !== 'deleted') {
      segments = change.whole || change.status === 'added' ? wholeFile(ctx.root, change.path) : addedSegments(ctx.root, change.path, options);
    }
    const result = evaluateFile(ctx, { path: change.path, segments, rules });
    results.push({ ...result, status: change.status });
  }

  const findings = results.flatMap((result) => result.findings);
  if (options.record !== false) {
    recordFindings(ctx, findings, { sessionId: options.sessionId, detectedBy: options.detectedBy ?? 'check' });
  }
  const active = findings.filter((item) => !item.suppressed);

  // Decisions that govern changed files but could not be verified mechanically.
  const needsJudgement = new Map();
  for (const result of results) {
    if (result.verdict !== 'unknown') continue;
    for (const { decision, constraints } of result.governing) {
      const undetectable = !constraints.length || constraints.some((c) => !c.protect && !c.patterns.length);
      if (!undetectable) continue;
      if (!needsJudgement.has(decision.id)) needsJudgement.set(decision.id, { decision, constraints, files: [] });
      needsJudgement.get(decision.id).files.push(result.path);
    }
  }

  return {
    mode,
    checked: results.length,
    verdict: worstVerdict([
      ...active.map((item) => item.verdict),
      ...results.filter((r) => r.verdict === 'unknown').map(() => 'unknown'),
    ]),
    files: results.filter((result) => result.governing.length || result.findings.length),
    findings: active,
    suppressed: findings.filter((item) => item.suppressed),
    excepted: results.flatMap((result) => result.excepted.map((entry) => ({ ...entry, path: result.path }))),
    needsJudgement: [...needsJudgement.values()],
  };
}
