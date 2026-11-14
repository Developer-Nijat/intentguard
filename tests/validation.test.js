import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ValidationError,
  compilePattern,
  detectSecret,
  validateAlternativeInput,
  validateConstraintInput,
  validateDecisionInput,
  validateEvidenceInput,
  validateExceptionInput,
} from '../src/core/validation.js';

const base = { title: 'Use RabbitMQ', decision: 'Async via RabbitMQ', reason: 'Loose coupling' };

const issuesOf = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ValidationError, `expected ValidationError, got ${error}`);
    return error.issues.join('\n');
  }
  assert.fail('expected a ValidationError');
};

test('a minimal decision gets sensible defaults', () => {
  const value = validateDecisionInput(base);
  assert.deepEqual(value, {
    title: 'Use RabbitMQ',
    statement: 'Async via RabbitMQ',
    rationale: 'Loose coupling',
    type: 'architectural',
    source: 'developer',
    scope: [],
    keywords: [],
    constraints: [],
    evidence: [],
    alternatives: [],
  });
});

test('title, decision and reason are all required', () => {
  const issues = issuesOf(() => validateDecisionInput({}));
  assert.match(issues, /title is required/);
  assert.match(issues, /decision is required/);
  assert.match(issues, /reason is required/);
});

test('the reason is required because the why is the point', () => {
  assert.match(issuesOf(() => validateDecisionInput({ title: 'T', decision: 'D' })), /why a decision was made/);
});

test('field aliases and enum spellings are normalised', () => {
  const value = validateDecisionInput({
    title: 'T',
    statement: 'S',
    rationale: 'R',
    type: 'Security',
    source: 'Document',
    scope: 'services/**',
    tags: ['RabbitMQ', 'rabbitmq'],
    constraints: [{ rule: 'x', kind: 'Must Not', severity: 'HIGH', enforcement: 'Enforce' }],
  });
  assert.equal(value.type, 'security');
  assert.equal(value.source, 'document');
  assert.deepEqual(value.scope, ['services/**']);
  assert.deepEqual(value.keywords, ['rabbitmq']);
  assert.deepEqual(
    { kind: value.constraints[0].kind, severity: value.constraints[0].severity, enforcement: value.constraints[0].enforcement },
    { kind: 'must_not', severity: 'high', enforcement: 'enforce' },
  );
});

test('unknown enum values are rejected with the allowed list', () => {
  assert.match(issuesOf(() => validateDecisionInput({ ...base, type: 'vibes' })), /type must be one of: architectural/);
  assert.match(issuesOf(() => validateDecisionInput({ ...base, source: 'rumour' })), /source must be one of: developer, document, git, claude/);
});

test('constraints accept a bare string and default to must_not/medium', () => {
  const value = validateConstraintInput('Do not introduce Redux');
  assert.equal(value.rule, 'Do not introduce Redux');
  assert.equal(value.kind, 'must_not');
  assert.equal(value.severity, 'medium');
  assert.equal(value.enforcement, null);
  assert.equal(value.scope, null);
  assert.equal(value.protect, false);
});

test('detector patterns must be valid, bounded regular expressions', () => {
  assert.match(issuesOf(() => validateConstraintInput({ rule: 'r', patterns: ['(unclosed'] })), /not a valid regular expression/);
  assert.match(issuesOf(() => validateConstraintInput({ rule: 'r', patterns: ['a*'] })), /matches the empty string/);
  assert.match(issuesOf(() => validateConstraintInput({ rule: 'r', commandPatterns: ['x'.repeat(501)] })), /too long/);
  assert.doesNotThrow(() => validateConstraintInput({ rule: 'r', patterns: ["from ['\"]redux['\"]"] }));
});

test('(?i) prefix makes a pattern case-insensitive', () => {
  assert.equal(compilePattern('(?i)redux').test('import REDUX'), true);
  assert.equal(compilePattern('redux').test('import REDUX'), false);
  assert.equal(compilePattern('^import').test('const a = 1;\nimport x'), true, 'patterns are multi-line');
});

test('nested validation errors are collected, not short-circuited', () => {
  const issues = issuesOf(() =>
    validateDecisionInput({ ...base, constraints: [{ rule: '' }], alternatives: [{ title: 'Redis' }], scope: ['../x'] }),
  );
  assert.match(issues, /constraint.rule is required/);
  assert.match(issues, /alternative.reason is required/);
  assert.match(issues, /may not contain "\.\."/);
});

test('partial validation only checks the fields that are present', () => {
  assert.deepEqual(validateDecisionInput({ reason: 'New reason' }, { partial: true }), { rationale: 'New reason' });
  assert.deepEqual(validateDecisionInput({ scope: ['a/**'] }, { partial: true }), { scope: ['a/**'] });
  assert.match(issuesOf(() => validateDecisionInput({ title: '  ' }, { partial: true })), /title is required/);
});

test('evidence kind is inferred from the source', () => {
  assert.equal(validateEvidenceInput('docs/architecture.md').kind, 'file');
  assert.equal(validateEvidenceInput({ source: 'https://example.com/adr/12' }).kind, 'url');
  assert.equal(validateEvidenceInput({ source: 'a1b2c3d4' }).kind, 'commit');
  assert.equal(validateEvidenceInput({ source: 'Agreed in the 2026-03 architecture review' }).kind, 'note');
  assert.equal(validateEvidenceInput({ source: 'docs/x.md', kind: 'note' }).kind, 'note');
});

test('a rejected alternative needs the reason it was rejected', () => {
  assert.match(issuesOf(() => validateAlternativeInput({ title: 'Redis' })), /only useful with the reason/);
  assert.equal(validateAlternativeInput({ title: 'Redis', why: 'Extra infrastructure' }).reason, 'Extra infrastructure');
});

test('exceptions need a reason and a valid expiry', () => {
  assert.match(issuesOf(() => validateExceptionInput({})), /conscious, explained choice/);
  assert.match(issuesOf(() => validateExceptionInput({ reason: 'r', expires: 'someday' })), /not a valid date/);
  const value = validateExceptionInput({ reason: 'r', expires: '2030-01-02', scope: ['services/notification/**'] });
  assert.equal(value.expiresAt, '2030-01-02T00:00:00.000Z');
  assert.equal(value.approvedBy, 'developer');
});

test('secrets are detected', () => {
  const secrets = [
    'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'sk-abcdefghijklmnopqrstuvwxyz012345',
    'xoxb-1234567890-abcdefghij',
    'mongodb://admin:hunter2@db.internal:27017/app',
    'password = Sup3rS3cret!',
    'API_KEY: 9f8e7d6c5b4a3210',
  ];
  for (const secret of secrets) assert.ok(detectSecret(`see ${secret} here`), `should flag: ${secret}`);
});

test('ordinary engineering prose is not mistaken for a secret', () => {
  const fine = [
    'Passwords must be hashed with argon2id.',
    'The API key is read from the environment, never committed.',
    'password: required field on the login form',
    'Use the secret manager for all credentials.',
    'Connect via mongodb://localhost:27017/app in development.',
    'token = ${GITHUB_TOKEN}',
    'Tracked in DEC-0012 and commit a1b2c3d4e5f6.',
  ];
  for (const text of fine) assert.equal(detectSecret(text), null, `should not flag: ${text}`);
});

test('decision records refuse to store secrets in any field', () => {
  assert.match(
    issuesOf(() => validateDecisionInput({ ...base, reason: 'Use key AKIAIOSFODNN7EXAMPLE for uploads' })),
    /reason appears to contain a AWS access key.*never be stored/,
  );
  assert.match(
    issuesOf(() => validateDecisionInput({ ...base, constraints: [{ rule: 'connect with postgres://app:pw12345@db/prod' }] })),
    /credentials in URL/,
  );
  assert.match(issuesOf(() => validateEvidenceInput({ source: 'notes', description: 'password=Sup3rS3cret!' })), /inline credential/);
});

test('non-object input is rejected clearly', () => {
  assert.match(issuesOf(() => validateDecisionInput('just text')), /decision must be an object/);
  assert.match(issuesOf(() => validateDecisionInput(null)), /decision must be an object/);
  assert.match(issuesOf(() => validateDecisionInput({ ...base, scope: [42] })), /scope must contain only strings/);
});
