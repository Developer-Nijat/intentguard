/**
 * Acceptance criterion: false positives and false negatives are measured
 * separately. This suite runs the mechanical layer over a labelled corpus and
 * reports precision / recall for (1) change detection and (2) prompt relevance.
 *
 * Run just this file to see the numbers:  npm run test:accuracy
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCommand, evaluateFile } from '../src/core/conflict-engine.js';
import { grantException, recordDecision } from '../src/core/decision-engine.js';
import { findRelevant } from '../src/core/relevance.js';
import { DECISIONS, DETECTOR_CASES, EXCEPTIONS, PROMPT_CASES } from './fixtures/accuracy-corpus.js';
import { makeProject, meta } from './helpers.js';

/** Budgets: the suite fails if the mechanical layer gets worse than this. */
const BUDGET = {
  detector: { falsePositives: 1, falseNegatives: 2 },
  relevance: { falsePositives: 1, falseNegatives: 1 },
};

function seed(t) {
  const { ctx } = makeProject(t);
  const ids = {};
  for (const [key, decision] of Object.entries(DECISIONS)) ids[key] = recordDecision(ctx, decision, meta).id;
  for (const exception of EXCEPTIONS) grantException(ctx, ids[exception.decision], exception);
  const keys = Object.fromEntries(Object.entries(ids).map(([key, id]) => [id, key]));
  return { ctx, ids, keys };
}

const pct = (n, d) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);

function report(t, title, m) {
  t.diagnostic(
    `${title}: ${m.total} cases — TP ${m.tp}, TN ${m.tn}, FP ${m.fp}, FN ${m.fn} | precision ${pct(m.tp, m.tp + m.fp)}, recall ${pct(m.tp, m.tp + m.fn)}, false-positive rate ${pct(m.fp, m.fp + m.tn)}, false-negative rate ${pct(m.fn, m.fn + m.tp)}`,
  );
  for (const note of m.notes) t.diagnostic(`  ${note}`);
}

test('change detection: false positives and false negatives on the labelled corpus', (t) => {
  const { ctx } = seed(t);
  const m = { total: DETECTOR_CASES.length, tp: 0, tn: 0, fp: 0, fn: 0, notes: [] };
  const surprises = [];

  for (const testCase of DETECTOR_CASES) {
    const { change } = testCase;
    const result = change.command
      ? evaluateCommand(ctx, { command: change.command })
      : evaluateFile(ctx, { path: change.path, segments: [{ startLine: 1, text: change.text }] });
    const flagged = result.findings.length > 0;

    let outcome;
    if (testCase.violates && flagged) outcome = 'tp';
    else if (!testCase.violates && !flagged) outcome = 'tn';
    else if (flagged) outcome = 'fp';
    else outcome = 'fn';
    m[outcome]++;

    const wrong = outcome === 'fp' || outcome === 'fn';
    if (wrong && testCase.known) m.notes.push(`known ${outcome.toUpperCase()}: ${testCase.name} — ${testCase.known}`);
    if (wrong && !testCase.known) surprises.push(`unexpected ${outcome.toUpperCase()}: ${testCase.name}`);
    if (!wrong && testCase.known) surprises.push(`"${testCase.name}" is labelled as a known miss but is now handled correctly — remove the label`);
  }

  report(t, 'Change detection', m);
  assert.deepEqual(surprises, []);
  assert.ok(m.fp <= BUDGET.detector.falsePositives, `false positives ${m.fp} exceed budget ${BUDGET.detector.falsePositives}`);
  assert.ok(m.fn <= BUDGET.detector.falseNegatives, `false negatives ${m.fn} exceed budget ${BUDGET.detector.falseNegatives}`);
});

test('prompt relevance: false positives and false negatives on the labelled corpus', (t) => {
  const { ctx, ids, keys } = seed(t);
  const m = { total: 0, tp: 0, tn: 0, fp: 0, fn: 0, notes: [] };
  const surprises = [];

  for (const testCase of PROMPT_CASES) {
    const surfaced = new Set(findRelevant(ctx, testCase.prompt, { limit: 10 }).decisions.map((match) => keys[match.decision.id]));
    const relevant = new Set(testCase.relevant);
    const errors = [];
    // Score every (prompt, decision) pair so true negatives are counted too.
    for (const key of Object.keys(ids)) {
      m.total++;
      const shown = surfaced.has(key);
      const wanted = relevant.has(key);
      if (shown && wanted) m.tp++;
      else if (!shown && !wanted) m.tn++;
      else if (shown) {
        m.fp++;
        errors.push(`FP ${key}`);
      } else {
        m.fn++;
        errors.push(`FN ${key}`);
      }
    }
    if (errors.length && testCase.known) m.notes.push(`known ${errors.join(', ')}: "${testCase.prompt}" — ${testCase.known}`);
    if (errors.length && !testCase.known) surprises.push(`unexpected ${errors.join(', ')}: "${testCase.prompt}"`);
    if (!errors.length && testCase.known) surprises.push(`"${testCase.prompt}" is labelled as a known miss but is now correct — remove the label`);
  }

  report(t, 'Prompt relevance', m);
  assert.deepEqual(surprises, []);
  assert.ok(m.fp <= BUDGET.relevance.falsePositives, `false positives ${m.fp} exceed budget ${BUDGET.relevance.falsePositives}`);
  assert.ok(m.fn <= BUDGET.relevance.falseNegatives, `false negatives ${m.fn} exceed budget ${BUDGET.relevance.falseNegatives}`);
});

test('a missed detection still degrades to "unknown", never to a silent "compatible"', (t) => {
  const { ctx } = seed(t);
  for (const testCase of DETECTOR_CASES.filter((c) => c.known?.startsWith('false-negative') && c.change.path)) {
    const result = evaluateFile(ctx, { path: testCase.change.path, segments: [{ startLine: 1, text: testCase.change.text }] });
    assert.ok(result.governing.length > 0, `${testCase.name}: the governing decision is still put in front of Claude`);
  }
});
