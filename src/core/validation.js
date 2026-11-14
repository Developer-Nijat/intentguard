/**
 * Input validation and normalisation for everything that gets stored.
 * Deliberately dependency-free: the plugin must run straight from a git clone.
 */
import { validateGlob } from './scope-matcher.js';

export const DECISION_TYPES = ['architectural', 'technical', 'business', 'process', 'security', 'convention'];
export const DECISION_STATUSES = ['proposed', 'active', 'superseded', 'deprecated'];
/** Where a decision came from. These are never merged or silently upgraded. */
export const SOURCES = ['developer', 'document', 'git', 'claude'];
export const CONSTRAINT_KINDS = ['must', 'must_not'];
export const SEVERITIES = ['low', 'medium', 'high', 'critical'];
export const ENFORCEMENTS = ['observe', 'warn', 'enforce'];
export const EVIDENCE_KINDS = ['file', 'url', 'commit', 'conversation', 'note'];
export const CONFLICT_STATUSES = ['pending', 'resolved', 'dismissed'];
export const RESOLUTIONS = ['kept', 'decision_updated', 'exception_granted', 'false_positive'];
export const VERDICTS = ['compatible', 'unknown', 'potential_conflict', 'confirmed_violation'];

export class ValidationError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(`Invalid input:\n${list.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ValidationError';
    this.issues = list;
  }
}

export class NotFoundError extends Error {
  constructor(what, id) {
    super(`${what} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

/* ------------------------------------------------------------------ secrets */

const SECRET_PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['API secret key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['credentials in URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i],
  [
    'inline credential',
    // key = value where the value mixes letters and digits (so prose like "password: required" passes)
    /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?(?!\$\{|<)(?=[^\s"'<>]*\d)(?=[^\s"'<>]*[A-Za-z])[^\s"'<>]{8,}/i,
  ],
];

/** Returns the kind of secret found in `text`, or null. */
export function detectSecret(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const [label, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/* ----------------------------------------------------------------- patterns */

/**
 * Compile a detector pattern. Patterns are JavaScript regular expression
 * sources matched per line (`m` flag); a leading `(?i)` makes one case-insensitive.
 */
export function compilePattern(source) {
  let body = String(source);
  let flags = 'm';
  if (body.startsWith('(?i)')) {
    body = body.slice(4);
    flags += 'i';
  }
  return new RegExp(body, flags);
}

function validatePattern(source, label, issues) {
  if (typeof source !== 'string' || !source.trim()) {
    issues.push(`${label} must be a non-empty string`);
    return;
  }
  if (source.length > 500) {
    issues.push(`${label} is too long (max 500 characters)`);
    return;
  }
  try {
    const regex = compilePattern(source);
    if (regex.test('')) issues.push(`${label} matches the empty string and would flag everything`);
  } catch (error) {
    issues.push(`${label} is not a valid regular expression: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ helpers */

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pick(input, ...names) {
  for (const name of names) {
    if (input[name] !== undefined && input[name] !== null) return input[name];
  }
  return undefined;
}

function stringList(value, label, issues, { max = 50 } = {}) {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      issues.push(`${label} must contain only strings`);
      return [];
    }
    for (const part of item.split(/\r?\n/)) {
      const trimmed = part.trim();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    }
  }
  if (out.length > max) issues.push(`${label} has too many entries (max ${max})`);
  return out;
}

/** Keywords are case-insensitive: lower-case first, then de-duplicate. */
function keywordList(value, label, issues, max) {
  return [...new Set(stringList(value, label, issues, { max }).map((keyword) => keyword.toLowerCase()))];
}

function oneOf(value, allowed, label, issues, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalised = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!allowed.includes(normalised)) {
    issues.push(`${label} must be one of: ${allowed.join(', ')} (got "${value}")`);
    return fallback;
  }
  return normalised;
}

function limited(value, label, max, issues) {
  if (value.length > max) issues.push(`${label} is too long (max ${max} characters)`);
  return value;
}

function scopeList(value, label, issues) {
  const globs = stringList(value, label, issues);
  for (const glob of globs) {
    const problem = validateGlob(glob);
    if (problem) issues.push(`${label}: ${problem} ("${glob}")`);
  }
  return globs;
}

function refuseSecrets(fields, issues) {
  for (const [label, value] of Object.entries(fields)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const kind = detectSecret(item);
      if (kind) {
        issues.push(`${label} appears to contain a ${kind}. Secrets must never be stored in decision records.`);
        break;
      }
    }
  }
}

function assertObject(input, what) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${what} must be an object`);
  }
}

function finish(issues, value) {
  if (issues.length) throw new ValidationError(issues);
  return value;
}

/* --------------------------------------------------------------- validators */

export function validateConstraintInput(input, { nested = false } = {}) {
  if (typeof input === 'string') input = { rule: input };
  assertObject(input, 'constraint');
  const issues = [];
  const label = nested ? 'constraint' : 'constraint';

  const rule = limited(text(pick(input, 'rule', 'text', 'description')), `${label}.rule`, 500, issues);
  if (!rule) issues.push(`${label}.rule is required`);

  const scopeValue = pick(input, 'scope');
  const scope = scopeValue === undefined ? null : scopeList(scopeValue, `${label}.scope`, issues);
  const patterns = stringList(pick(input, 'patterns', 'pattern'), `${label}.patterns`, issues, { max: 20 });
  const commandPatterns = stringList(
    pick(input, 'commandPatterns', 'command_patterns', 'commandPattern'),
    `${label}.commandPatterns`,
    issues,
    { max: 20 },
  );
  patterns.forEach((p) => validatePattern(p, `${label}.patterns "${p}"`, issues));
  commandPatterns.forEach((p) => validatePattern(p, `${label}.commandPatterns "${p}"`, issues));

  const value = {
    rule,
    kind: oneOf(pick(input, 'kind'), CONSTRAINT_KINDS, `${label}.kind`, issues, 'must_not'),
    severity: oneOf(pick(input, 'severity'), SEVERITIES, `${label}.severity`, issues, 'medium'),
    enforcement: oneOf(pick(input, 'enforcement'), ENFORCEMENTS, `${label}.enforcement`, issues, null),
    scope: scope && scope.length ? scope : null,
    patterns,
    commandPatterns,
    protect: pick(input, 'protect') === true || pick(input, 'protect') === 'true',
  };
  refuseSecrets({ [`${label}.rule`]: rule }, issues);
  return finish(issues, value);
}

export function validateEvidenceInput(input) {
  if (typeof input === 'string') input = { source: input };
  assertObject(input, 'evidence');
  const issues = [];
  const source = limited(text(pick(input, 'source', 'path', 'url', 'ref')), 'evidence.source', 500, issues);
  if (!source) issues.push('evidence.source is required (a file path, URL, commit, or short note)');

  let inferred = 'note';
  if (/^https?:\/\//i.test(source)) inferred = 'url';
  else if (/^[0-9a-f]{7,40}$/i.test(source)) inferred = 'commit';
  else if (/[\\/.]/.test(source) && !/\s/.test(source)) inferred = 'file';

  const value = {
    kind: oneOf(pick(input, 'kind'), EVIDENCE_KINDS, 'evidence.kind', issues, inferred),
    source,
    locator: limited(text(pick(input, 'locator', 'section', 'lines')), 'evidence.locator', 200, issues),
    description: limited(text(pick(input, 'description', 'note')), 'evidence.description', 1000, issues),
  };
  refuseSecrets({ 'evidence.source': source, 'evidence.description': value.description }, issues);
  return finish(issues, value);
}

export function validateAlternativeInput(input) {
  if (typeof input === 'string') input = { title: input };
  assertObject(input, 'rejected alternative');
  const issues = [];
  const title = limited(text(pick(input, 'title', 'name', 'idea')), 'alternative.title', 200, issues);
  if (!title) issues.push('alternative.title is required');
  const reason = limited(
    text(pick(input, 'reason', 'rejectionReason', 'rejection_reason', 'why')),
    'alternative.reason',
    2000,
    issues,
  );
  if (!reason) issues.push('alternative.reason is required: a rejected idea is only useful with the reason it was rejected');
  const value = {
    title,
    description: limited(text(pick(input, 'description', 'details')), 'alternative.description', 2000, issues),
    reason,
    keywords: keywordList(pick(input, 'keywords', 'keyword', 'tags'), 'alternative.keywords', issues, 20),
  };
  refuseSecrets({ 'alternative.title': title, 'alternative.reason': reason, 'alternative.description': value.description }, issues);
  return finish(issues, value);
}

/**
 * Validate a full decision payload (with nested constraints, evidence and
 * rejected alternatives). `partial` validates only the fields present, for updates.
 */
export function validateDecisionInput(input, { partial = false } = {}) {
  assertObject(input, 'decision');
  const issues = [];
  const value = {};
  const has = (...names) => pick(input, ...names) !== undefined;

  if (!partial || has('title')) {
    value.title = limited(text(pick(input, 'title')), 'title', 200, issues);
    if (!value.title) issues.push('title is required');
  }
  if (!partial || has('statement', 'decision')) {
    value.statement = limited(text(pick(input, 'statement', 'decision')), 'decision', 2000, issues);
    if (!value.statement) issues.push('decision is required: state what was decided');
  }
  if (!partial || has('rationale', 'reason')) {
    value.rationale = limited(text(pick(input, 'rationale', 'reason', 'why')), 'reason', 4000, issues);
    if (!value.rationale && !partial) {
      issues.push('reason is required: IntentGuard records why a decision was made, not only what it is');
    }
  }
  if (!partial || has('type')) {
    value.type = oneOf(pick(input, 'type'), DECISION_TYPES, 'type', issues, 'architectural');
  }
  if (!partial || has('source')) {
    value.source = oneOf(pick(input, 'source'), SOURCES, 'source', issues, 'developer');
  }
  if (!partial || has('scope')) {
    value.scope = scopeList(pick(input, 'scope'), 'scope', issues);
  }
  if (!partial || has('keywords', 'keyword', 'tags')) {
    value.keywords = keywordList(pick(input, 'keywords', 'keyword', 'tags'), 'keywords', issues, 30);
  }

  const nested = (names, validator, target) => {
    const raw = pick(input, ...names);
    if (raw === undefined) {
      if (!partial) value[target] = [];
      return;
    }
    const list = Array.isArray(raw) ? raw : [raw];
    value[target] = [];
    for (const item of list) {
      try {
        value[target].push(validator(item));
      } catch (error) {
        if (error instanceof ValidationError) issues.push(...error.issues);
        else throw error;
      }
    }
  };
  nested(['constraints', 'constraint'], (item) => validateConstraintInput(item, { nested: true }), 'constraints');
  nested(['evidence'], validateEvidenceInput, 'evidence');
  nested(['alternatives', 'rejected', 'rejectedAlternatives'], validateAlternativeInput, 'alternatives');

  refuseSecrets(
    { title: value.title, decision: value.statement, reason: value.rationale, keywords: value.keywords ?? [] },
    issues,
  );
  return finish(issues, value);
}

export function validateExceptionInput(input) {
  assertObject(input, 'exception');
  const issues = [];
  const reason = limited(text(pick(input, 'reason', 'why')), 'exception.reason', 2000, issues);
  if (!reason) issues.push('exception.reason is required: an exception must be a conscious, explained choice');

  let expiresAt = null;
  const rawExpiry = pick(input, 'expiresAt', 'expires_at', 'expires');
  if (rawExpiry) {
    const date = new Date(rawExpiry);
    if (Number.isNaN(date.getTime())) issues.push(`exception.expires is not a valid date ("${rawExpiry}")`);
    else expiresAt = date.toISOString();
  }

  const value = {
    reason,
    scope: scopeList(pick(input, 'scope'), 'exception.scope', issues),
    constraintId: text(pick(input, 'constraintId', 'constraint_id', 'constraint')) || null,
    approvedBy: limited(text(pick(input, 'approvedBy', 'approved_by')) || 'developer', 'exception.approvedBy', 100, issues),
    expiresAt,
  };
  refuseSecrets({ 'exception.reason': reason }, issues);
  return finish(issues, value);
}

export function validateEnum(value, allowed, label) {
  const issues = [];
  const result = oneOf(value, allowed, label, issues, null);
  if (issues.length) throw new ValidationError(issues);
  if (result === null) throw new ValidationError(`${label} is required (one of: ${allowed.join(', ')})`);
  return result;
}
