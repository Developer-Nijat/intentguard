import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordDecision, rejectAlternative } from '../src/core/decision-engine.js';
import { deriveKeywords, extractPaths, findRelevant, looksLikeDecision, tokenize } from '../src/core/relevance.js';
import { GENERATED, MONGO, RABBIT, makeProject, meta } from './helpers.js';

test('tokenize lower-cases, drops stopwords and folds simple plurals', () => {
  assert.deepEqual([...tokenize('The Services are using RabbitMQ queues, and policies!')], ['service', 'using', 'rabbitmq', 'queue', 'policy']);
  assert.deepEqual([...tokenize('')], []);
  assert.deepEqual([...tokenize('Sorğu göndərən servis')], ['sorğu', 'göndərən', 'servis']);
});

test('deriveKeywords keeps the distinctive words of a title', () => {
  assert.deepEqual(deriveKeywords('Use RabbitMQ for async communication'), ['rabbitmq', 'async', 'communication']);
  assert.deepEqual(deriveKeywords('Do not add another logging library'), ['another', 'logging', 'library']);
});

test('extractPaths finds path-like fragments but not versions or URLs', () => {
  assert.deepEqual(extractPaths('edit apps/web/db.ts and schema.sql please'), ['apps/web/db.ts', 'schema.sql']);
  assert.deepEqual(extractPaths('upgrade to 1.2.3'), []);
  assert.deepEqual(extractPaths('windows path src\\generated\\client.ts'), ['src/generated/client.ts']);
});

function seeded(t) {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, meta);
  recordDecision(ctx, MONGO, meta);
  recordDecision(ctx, GENERATED, meta);
  rejectAlternative(ctx, { title: 'Redis for caching', reason: 'Existing infrastructure has no Redis and ops declined to add it' });
  return ctx;
}
const ids = (result) => result.decisions.map((m) => m.decision.id);

test('the README scenario: an HTTP call between services surfaces the RabbitMQ decision', (t) => {
  const ctx = seeded(t);
  const result = findRelevant(ctx, 'Implement direct HTTP communication between OrderService and NotificationService.');
  assert.deepEqual(ids(result), ['DEC-0001']);
  assert.ok(result.decisions[0].matched.includes('communication'));
});

test('keyword hits rank above incidental word overlap', (t) => {
  const ctx = seeded(t);
  const result = findRelevant(ctx, 'Query mongodb from the frontend dashboard and push to rabbitmq');
  assert.deepEqual(ids(result).sort(), ['DEC-0001', 'DEC-0002']);
  assert.equal(ids(result)[0], 'DEC-0002', 'two keyword hits beat one');
});

test('mentioning a path inside a scope is enough', (t) => {
  const ctx = seeded(t);
  const result = findRelevant(ctx, 'fix the typo in src/generated/client.ts');
  assert.deepEqual(ids(result), ['DEC-0003']);
  assert.equal(result.decisions[0].path, 'src/generated/client.ts');
});

test('unrelated requests match nothing', (t) => {
  const ctx = seeded(t);
  for (const prompt of ['Rename the variable in utils.js', 'Why is the build slow today?', 'Add a dark mode toggle to settings', 'ok thanks']) {
    const result = findRelevant(ctx, prompt);
    assert.deepEqual(ids(result), [], prompt);
    assert.deepEqual(result.alternatives, [], prompt);
  }
});

test('rejected ideas resurface when they are proposed again', (t) => {
  const ctx = seeded(t);
  const result = findRelevant(ctx, 'Could we put Redis in front of the product API?');
  assert.deepEqual(result.alternatives.map((m) => m.alternative.id), ['ALT-0002']);
});

test('only active decisions are surfaced by default', (t) => {
  const { ctx } = makeProject(t);
  recordDecision(ctx, RABBIT, { actor: 'claude' });
  assert.deepEqual(ids(findRelevant(ctx, 'publish to rabbitmq')), []);
  assert.deepEqual(ids(findRelevant(ctx, 'publish to rabbitmq', { statuses: ['active', 'proposed'] })), ['DEC-0001']);
});

test('the number of matches is capped', (t) => {
  const { ctx } = makeProject(t);
  for (let i = 0; i < 6; i++) {
    recordDecision(ctx, { title: `Payments rule ${i}`, decision: 'd', reason: 'r', keywords: ['payments'] }, meta);
  }
  assert.equal(findRelevant(ctx, 'change the payments flow').decisions.length, 3);
  assert.equal(findRelevant(ctx, 'change the payments flow', { limit: 5 }).decisions.length, 5);
});

test('looksLikeDecision recognises durable decision language', () => {
  const yes = [
    'From now on all call recordings are stored in MinIO.',
    "We've decided to go with PostgreSQL for the reporting module.",
    'We must never call the database from the frontend.',
    'Never use Redux in this project, we standardised on Zustand.',
    "Let's standardize on pnpm for the monorepo.",
    'As a rule, legacy modules are off-limits.',
    'Going forward, API response formats are frozen.',
    'Bundan sonra bütün zəng qeydləri MinIO-da saxlanmalıdır.',
  ];
  for (const text of yes) assert.equal(looksLikeDecision(text), true, text);
});

test('looksLikeDecision ignores ordinary requests', () => {
  const no = [
    'Fix the failing test in cart.spec.ts',
    'Can you add pagination to the orders endpoint?',
    "Don't touch the formatting, just rename the function.",
    'Use a map here instead of a loop.',
    'What does this function do?',
    '/intentguard:remember from now on we use pnpm',
    'ok',
  ];
  for (const text of no) assert.equal(looksLikeDecision(text), false, text);
});
