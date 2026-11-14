import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT, packageVersion } from '../src/cli/index.js';
import { GENERATED, MONGO, RABBIT, cli, hasGit, git, makeProject, runBin, tempDir, write } from './helpers.js';

const IMPORT = "import { MongoClient } from 'mongodb';";

const addFlags = (decision) => [
  'add',
  '--title', decision.title,
  '--decision', decision.decision,
  '--reason', decision.reason,
  ...decision.scope.flatMap((glob) => ['--scope', glob]),
  '--confirmed',
];

async function seed(root, decision, ...extra) {
  const file = write(root, `.tmp-${Math.random().toString(36).slice(2)}.json`, JSON.stringify(decision));
  const result = await cli(root, 'add', '--input', file, ...extra);
  fs.rmSync(file);
  assert.equal(result.code, 0, result.err);
  return result;
}

test('help, version and unknown commands', async (t) => {
  const dir = tempDir(t);
  const help = await cli(dir, 'help');
  assert.equal(help.code, EXIT.ok);
  assert.match(help.out, /intentguard <command>/);
  assert.equal((await cli(dir)).code, EXIT.ok);
  assert.equal((await cli(dir, '--version')).out, packageVersion());
  const unknown = await cli(dir, 'frobnicate');
  assert.equal(unknown.code, EXIT.usage);
  assert.match(unknown.err, /Unknown command "frobnicate"/);
});

test('commands explain how to initialise when the project is not set up', async (t) => {
  const dir = tempDir(t);
  for (const command of ['status', 'list', 'check', 'conflicts', 'review', 'history']) {
    const result = await cli(dir, command);
    assert.equal(result.code, EXIT.notInitialised, command);
    assert.match(result.err, /not initialised.*\/intentguard:init/, command);
  }
});

test('init creates a local, git-ignored store and is idempotent', async (t) => {
  const dir = tempDir(t);
  const first = await cli(dir, 'init');
  assert.equal(first.code, EXIT.ok);
  assert.match(first.out, /IntentGuard initialised/);
  assert.match(first.out, /Enforcement mode: warn/);
  assert.ok(fs.existsSync(path.join(dir, '.intentguard', 'intentguard.db')));
  assert.match(fs.readFileSync(path.join(dir, '.intentguard', '.gitignore'), 'utf8'), /\*\.db/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.intentguard', 'config.json'), 'utf8')).enforcement, 'warn');

  const again = await cli(dir, 'init', '--enforcement', 'enforce');
  assert.match(again.out, /already initialised/);
  assert.match(again.out, /Enforcement mode: enforce/);
  assert.equal((await cli(dir, 'init', '--enforcement', 'loud')).code, EXIT.usage);
});

test('init from a subdirectory of a git repository uses the repository root', { skip: !hasGit }, async (t) => {
  const dir = tempDir(t);
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });
  await cli(path.join(dir, 'packages', 'api'), 'init');
  assert.ok(fs.existsSync(path.join(dir, '.intentguard', 'config.json')));
  assert.equal((await cli(path.join(dir, 'packages', 'api'), 'status')).code, EXIT.ok, 'found from below');
});

test('add with flags records a decision in one command', async (t) => {
  const { root } = makeProject(t);
  const result = await cli(root, ...addFlags({ ...RABBIT, decision: RABBIT.decision }), '--must-not', 'No direct synchronous HTTP calls between services');
  assert.equal(result.code, EXIT.ok, result.err);
  assert.match(result.out, /Recorded DEC-0001 \(active\)/);
  assert.match(result.out, /CON-0001 MUST NOT \[medium, warn\]: No direct synchronous HTTP calls between services/);
  assert.match(result.out, /detectors: none — needs semantic review/);
  assert.match(result.out, /Source: stated by the developer/);
});

test('add without --confirmed stores a proposal and says how to confirm it', async (t) => {
  const { root } = makeProject(t);
  const args = addFlags(RABBIT).filter((arg) => arg !== '--confirmed');
  const result = await cli(root, ...args, '--source', 'claude', '--actor', 'claude');
  assert.match(result.out, /Saved DEC-0001 as PROPOSED/);
  assert.match(result.out, /intentguard confirm DEC-0001/);
  assert.match(result.out, /Source: suggested by Claude/);
  const confirmed = await cli(root, 'confirm', 'DEC-0001');
  assert.match(confirmed.out, /Confirmed DEC-0001: .* now active/);
});

test('add --input reads JSON (with a UTF-8 BOM) including nested records', async (t) => {
  const { root } = makeProject(t, { 'docs/architecture.md': '# Architecture\n' });
  const file = write(root, 'decision.json', `﻿${JSON.stringify(MONGO)}`);
  const result = await cli(root, 'add', '--input', file, '--confirmed');
  assert.equal(result.code, EXIT.ok, result.err);
  assert.match(result.out, /EVD-0001 file: docs\/architecture\.md \(section 3\) — verified/);
  assert.match(result.out, /ALT-0001 Realm SDK in the browser — rejected: Bypasses the authorization layer/);
  assert.match(result.out, /detectors: content .*; commands /);
});

test('add reports validation problems as usage errors, not stack traces', async (t) => {
  const { root } = makeProject(t);
  const missing = await cli(root, 'add', '--title', 'Only a title');
  assert.equal(missing.code, EXIT.usage);
  assert.match(missing.err, /decision is required/);
  assert.match(missing.err, /reason is required/);
  assert.doesNotMatch(missing.err, /at .*\.js:\d+/);

  const badJson = await cli(root, 'add', '--input', write(root, 'bad.json', '{nope'));
  assert.equal(badJson.code, EXIT.usage);
  assert.match(badJson.err, /not valid JSON/);
  assert.equal((await cli(root, 'add', '--input', 'missing.json')).code, EXIT.usage);
  assert.equal((await cli(root, 'add', '--no-such-flag')).code, EXIT.usage);

  const secret = await cli(root, ...addFlags({ ...RABBIT, reason: 'Broker password = Sup3rS3cret!' }));
  assert.equal(secret.code, EXIT.usage);
  assert.match(secret.err, /Secrets must never be stored/);
});

test('--protect and --pattern shortcuts build a constraint with detectors', async (t) => {
  const { root } = makeProject(t);
  const protectedDecision = await cli(root, ...addFlags(GENERATED), '--protect', '--severity', 'critical', '--enforcement', 'enforce');
  assert.match(protectedDecision.out, /MUST NOT \[critical, enforce\]: Do not modify files in this scope/);
  assert.match(protectedDecision.out, /detectors: protected path \(any change\)/);

  const patterned = await cli(root, ...addFlags(MONGO), '--must-not', 'No MongoDB driver', '--pattern', "from ['\"]mongodb['\"]");
  assert.match(patterned.out, /detectors: content \/from \['"\]mongodb\['"\]\//);

  const orphan = await cli(root, ...addFlags({ ...RABBIT, title: 'Another' }), '--pattern', 'axios');
  assert.equal(orphan.code, EXIT.usage);
  assert.match(orphan.err, /need a rule/);
});

test('why answers by ID, by file path and by topic', async (t) => {
  const { root } = makeProject(t, { 'docs/architecture.md': '# Architecture\n', 'apps/web/db.js': '' });
  await seed(root, MONGO, '--confirmed');
  await seed(root, RABBIT, '--confirmed');

  const byId = await cli(root, 'why', 'dec-1');
  assert.match(byId.out, /^DEC-0001 · Frontend must never access MongoDB directly/);
  assert.match(byId.out, /Reason: All business operations must pass through the backend authorization layer\./);

  const byConstraint = await cli(root, 'why', 'CON-0002');
  assert.match(byConstraint.out, /DEC-0002 · Use RabbitMQ/);

  const byPath = await cli(root, 'why', 'apps/web/db.js');
  assert.match(byPath.out, /Decisions governing apps\/web\/db\.js:/);
  assert.match(byPath.out, /DEC-0001/);
  assert.doesNotMatch(byPath.out, /DEC-0002/);
  assert.match((await cli(root, 'why', 'README.md/nothing')).out, /No recorded decision governs/);

  const byTopic = await cli(root, 'why', 'rabbitmq', 'queues');
  assert.match(byTopic.out, /DEC-0002 · Use RabbitMQ/);
  const byIdea = await cli(root, 'why', 'realm sdk');
  assert.match(byIdea.out, /ALT-0001 · Rejected idea: Realm SDK in the browser/);
  assert.match((await cli(root, 'why', 'kubernetes')).out, /No recorded decision or rejected idea matches/);

  assert.equal((await cli(root, 'why', 'DEC-0099')).code, EXIT.usage);
  assert.equal((await cli(root, 'why')).code, EXIT.usage);
});

test('list filters by status and by governing path', async (t) => {
  const { root } = makeProject(t);
  await seed(root, MONGO, '--confirmed');
  await seed(root, RABBIT);
  const all = await cli(root, 'list');
  assert.match(all.out, /DEC-0001 \[architectural\] Frontend/);
  assert.match(all.out, /DEC-0002 \[architectural\] \(proposed\) Use RabbitMQ/);
  assert.doesNotMatch((await cli(root, 'list', '--status', 'active')).out, /DEC-0002/);
  assert.doesNotMatch((await cli(root, 'list', '--path', 'services/a.js')).out, /DEC-0001/);
  assert.match((await cli(root, 'list', '--status', 'deprecated')).out, /No decisions recorded/);
  const json = JSON.parse((await cli(root, 'list', '--json')).out);
  assert.deepEqual(json.map((d) => d.id), ['DEC-0001', 'DEC-0002']);
});

test('update, supersede, deprecate and history tell the story of a decision', async (t) => {
  const { root } = makeProject(t);
  await seed(root, RABBIT, '--confirmed');
  const updated = await cli(root, 'update', 'DEC-0001', '--reason', 'Failure isolation.', '--note', 'Sharper reason');
  assert.match(updated.out, /Updated DEC-0001 \(revision 2\)/);

  const next = write(root, 'next.json', JSON.stringify({ title: 'Services may call each other over HTTP', decision: 'Sync HTTP is allowed.', reason: 'The broker caused most incidents.', scope: ['services/**'] }));
  const superseded = await cli(root, 'supersede', 'DEC-0001', '--input', next, '--confirmed');
  assert.match(superseded.out, /DEC-0001 is now superseded by DEC-0002/);
  assert.match((await cli(root, 'why', 'DEC-0001')).out, /Status: superseded by DEC-0002/);

  assert.match((await cli(root, 'deprecate', 'DEC-0002', '--note', 'Monolith now')).out, /DEC-0002 is now deprecated/);
  assert.match((await cli(root, 'reactivate', 'DEC-0002')).out, /DEC-0002 is now active/);

  const history = await cli(root, 'history', 'DEC-0001');
  const order = history.out.split('\n').map((line) => line.split(/\s{2,}/)[2]);
  assert.deepEqual(order, ['decision.superseded', 'decision.updated', 'constraint.added', 'decision.created']);
  assert.match(history.out, /Sharper reason/);
  assert.equal((await cli(root, 'history', '--limit', '2')).out.split('\n').length, 2);
});

test('check reports a conflict, records it, and can gate CI with --fail-on', async (t) => {
  const { root } = makeProject(t, { 'docs/architecture.md': '# A\n', 'apps/web/db.js': `${IMPORT}\n`, 'apps/web/ok.js': 'export {};\n' });
  await seed(root, MONGO, '--confirmed');

  const clean = await cli(root, 'check', 'apps/web/ok.js', '--fail-on', 'potential_conflict');
  assert.equal(clean.code, EXIT.ok);
  assert.match(clean.out, /Verdict: COMPATIBLE/);

  const dry = await cli(root, 'check', 'apps/web/db.js', '--dry-run');
  assert.match(dry.out, /Verdict: POTENTIAL CONFLICT/);
  assert.match((await cli(root, 'conflicts')).out, /No pending conflicts/);

  const failing = await cli(root, 'check', 'apps/web/db.js', '--fail-on', 'potential_conflict');
  assert.equal(failing.code, EXIT.failed);
  assert.match(failing.out, /CONF-0001 · POTENTIAL CONFLICT with DEC-0001/);
  assert.match(failing.out, /Evidence: docs\/architecture\.md \(section 3\)/);
  assert.equal((await cli(root, 'check', 'apps/web/db.js', '--fail-on', 'confirmed_violation')).code, EXIT.ok);
  assert.equal((await cli(root, 'check', '--fail-on', 'sometimes')).code, EXIT.usage);

  const json = JSON.parse((await cli(root, 'check', 'apps/web/db.js', '--json')).out);
  assert.equal(json.verdict, 'potential_conflict');
  assert.equal(json.findings[0].conflictId, 'CONF-0001');
});

test('check --plan compares an intention with decisions before code exists', async (t) => {
  const { root } = makeProject(t);
  await seed(root, RABBIT, '--confirmed');
  const related = await cli(root, 'check', '--plan', 'Call NotificationService over HTTP directly from OrderService for async communication');
  assert.match(related.out, /Verdict: UNKNOWN/);
  assert.match(related.out, /DEC-0001 "Use RabbitMQ for async communication"/);
  const unrelated = await cli(root, 'check', '--plan', 'Rename a CSS class');
  assert.match(unrelated.out, /Verdict: COMPATIBLE/);
});

test('conflicts are listed and resolved by the developer’s choice', async (t) => {
  const { root } = makeProject(t, { 'apps/web/db.js': `${IMPORT}\n`, 'apps/web/seed.js': `${IMPORT}\n` });
  await seed(root, MONGO, '--confirmed');
  await cli(root, 'check', 'apps/web/db.js', 'apps/web/seed.js');

  const pending = await cli(root, 'conflicts');
  assert.match(pending.out, /CONF-0001 \[pending\] DEC-0001/);
  assert.match(pending.out, /CONF-0002 \[pending\] DEC-0001/);
  assert.match(pending.out, /→ import \{ MongoClient \} from 'mongodb';/);

  assert.equal((await cli(root, 'resolve', 'CONF-0001')).code, EXIT.usage);
  assert.equal((await cli(root, 'resolve', 'CONF-0001', '--as', 'maybe')).code, EXIT.usage);
  const needsReason = await cli(root, 'resolve', 'CONF-0002', '--as', 'exception');
  assert.equal(needsReason.code, EXIT.usage);
  assert.match(needsReason.err, /needs a reason/);

  assert.match((await cli(root, 'resolve', 'CONF-0001', '--as', 'kept', '--note', 'Will call the API')).out, /CONF-0001 resolved \(kept\)/);
  const exception = await cli(root, 'resolve', 'CONF-0002', '--as', 'exception', '--note', 'Seed script, CI only', '--expires', '2030-01-01');
  assert.match(exception.out, /Granted EXC-0001 \(scope: apps\/web\/seed\.js\)/);

  assert.match((await cli(root, 'conflicts')).out, /No pending conflicts/);
  assert.match((await cli(root, 'conflicts', '--status', 'all')).out, /CONF-0002 \[resolved: exception_granted\]/);
  assert.match((await cli(root, 'exception', 'list')).out, /EXC-0001 DEC-0001 \[in force\] apps\/web\/seed\.js — Seed script, CI only/);

  const recheck = await cli(root, 'check', 'apps/web/seed.js');
  assert.match(recheck.out, /Verdict: COMPATIBLE/);
  assert.match(recheck.out, /Covered by explicit exceptions:\n- apps\/web\/seed\.js: EXC-0001 for DEC-0001/);

  assert.match((await cli(root, 'exception', 'revoke', 'EXC-0001')).out, /Revoked EXC-0001/);
  assert.match((await cli(root, 'check', 'apps/web/seed.js')).out, /POTENTIAL CONFLICT/);
});

test('constraint, evidence and reject subcommands', async (t) => {
  const { root } = makeProject(t, { 'docs/adr-7.md': 'ADR 7\n' });
  await seed(root, RABBIT, '--confirmed');
  const constraint = await cli(root, 'constraint', 'add', 'DEC-0001', '--rule', 'No axios between services', '--pattern', "from ['\"]axios['\"]", '--severity', 'high');
  assert.match(constraint.out, /Added CON-0002 MUST NOT \[high, warn\]: No axios between services to DEC-0001/);
  assert.match((await cli(root, 'constraint', 'remove', 'CON-0002')).out, /Removed CON-0002/);
  assert.equal((await cli(root, 'constraint', 'add', 'DEC-0001')).code, EXIT.usage);

  assert.match((await cli(root, 'evidence', 'add', 'DEC-0001', '--source', 'docs/adr-7.md', '--locator', 'Decision')).out, /Added evidence EVD-0001 \(file: docs\/adr-7\.md\)/);
  assert.match((await cli(root, 'evidence', 'add', 'DEC-0001', '--source', 'docs/gone.md')).out, /could not be verified/);

  const rejected = await cli(root, 'reject', '--title', 'Kafka', '--reason', 'Overkill at our volume', '--decision', 'DEC-0001');
  assert.match(rejected.out, /Remembered rejected idea ALT-0001: Kafka/);
  assert.match((await cli(root, 'rejected')).out, /ALT-0001 Kafka \(DEC-0001\) — rejected: Overkill at our volume/);
  assert.equal((await cli(root, 'reject', '--title', 'Kafka')).code, EXIT.usage);
});

test('review reports drift and --keep re-affirms a decision', async (t) => {
  const { root } = makeProject(t, { 'docs/architecture.md': '# v1\n', 'apps/web/db.js': `${IMPORT}\n` });
  await seed(root, MONGO, '--confirmed');
  write(root, 'docs/architecture.md', '# v2\n');
  const review = await cli(root, 'review');
  assert.match(review.out, /\[high\] violated_in_code: CON-0001 is already contradicted by 1 file\(s\).*apps\/web\/db\.js/);
  assert.match(review.out, /\[medium\] evidence_changed/);
  assert.match((await cli(root, 'review', '--keep', 'DEC-0001')).out, /DEC-0001 reviewed and kept; evidence re-verified/);
  assert.doesNotMatch((await cli(root, 'review')).out, /evidence_changed/);
});

test('status summarises the store', async (t) => {
  const { root } = makeProject(t);
  await seed(root, MONGO, '--confirmed');
  await seed(root, RABBIT);
  const status = await cli(root, 'status');
  assert.match(status.out, /Decisions: 1 proposed, 1 active, 0 superseded, 0 deprecated/);
  assert.match(status.out, /Active constraints: 1 · Rejected ideas: 1/);
  assert.match(status.out, /local only/);
});

test('purge deletes everything, but only with --yes', async (t) => {
  const { root, ctx } = makeProject(t);
  await seed(root, RABBIT, '--confirmed');
  const refused = await cli(root, 'purge');
  assert.equal(refused.code, EXIT.usage);
  assert.match(refused.err, /Re-run with --yes/);
  assert.ok(fs.existsSync(path.join(root, '.intentguard')));
  ctx.close();
  assert.equal((await cli(root, 'purge', '--yes')).code, EXIT.ok);
  assert.equal(fs.existsSync(path.join(root, '.intentguard')), false);
  assert.equal((await cli(root, 'status')).code, EXIT.notInitialised);
});

test('the real executable works end to end and keeps stderr clean', (t) => {
  const dir = tempDir(t);
  const init = runBin(dir, ['init']);
  assert.equal(init.code, 0);
  assert.equal(init.stderr, '');
  const add = runBin(dir, ['add', '--input', '-', '--confirmed', '--json'], JSON.stringify(RABBIT));
  assert.equal(add.code, 0, add.stderr);
  assert.equal(JSON.parse(add.stdout).id, 'DEC-0001');
  const missing = runBin(dir, ['why', 'DEC-0042']);
  assert.equal(missing.code, EXIT.usage);
  assert.match(missing.stderr, /Decision not found: DEC-0042/);
});
