/**
 * Lightweight, local relevance matching between free text (a user prompt or a
 * plan) and recorded decisions / rejected ideas.
 *
 * This is deliberately a cheap keyword matcher, not semantics: its only job is
 * to put the right decision records in front of Claude, which then does the
 * actual reasoning. No text ever leaves the machine.
 */
import { matchesScope, normalizePath } from './scope-matcher.js';

const STOPWORDS = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in into is it its
   may me might more most my no not of on or our out over shall should so than that the their them then there
   these they this those to too under up us was we were what when where which while who why will with would you your
   please just also about after again all any because before between both each few here need want make made
   let lets get got like some such only own same very`.split(/\s+/),
);

/** Words too generic in engineering talk to identify a decision on their own. */
const GENERIC = new Set(
  `use used using must never always avoid allow allowed keep new add added adding change changed changing update
   remove create implement implementation code file files project app application system service services module
   modules feature features layer data via through directly direct instead only every within without when
   should cannot dont do not no one way via per support based existing current default general common
   function functions method class value values type types name names thing things work works working`.split(/\s+/),
);

function normalizeToken(raw) {
  let token = raw.toLowerCase();
  if (token.length > 4 && token.endsWith('ies')) token = `${token.slice(0, -3)}y`;
  else if (token.length > 3 && token.endsWith('s') && !/(?:ss|us|is)$/.test(token)) token = token.slice(0, -1); // not redis, status, class
  return token;
}

/** Split text into a set of normalised, meaningful tokens. */
export function tokenize(text) {
  const tokens = new Set();
  for (const raw of String(text ?? '').split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    const token = normalizeToken(raw);
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/** Pick distinctive keywords from a title, for records created without explicit keywords. */
export function deriveKeywords(...texts) {
  const out = [];
  const seen = new Set();
  for (const raw of texts.join(' ').split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || /^\d+$/.test(raw)) continue;
    const token = normalizeToken(raw);
    if (STOPWORDS.has(token) || GENERIC.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(raw.toLowerCase()); // keep the word as written; matching normalises both sides
    if (out.length >= 8) break;
  }
  return out;
}

/** Path-like fragments mentioned in free text ("apps/web/db.ts", "schema.sql"). */
export function extractPaths(text) {
  const found = new Set();
  const pattern = /(?:[\w.@-]+[\\/])+[\w.@-]+|\b[\w-]+\.[a-z][a-z0-9]{1,5}\b/gi;
  for (const match of String(text ?? '').matchAll(pattern)) {
    const candidate = normalizePath(match[0]);
    if (candidate && !/^\d+(\.\d+)+$/.test(candidate) && !/^https?:/i.test(candidate)) found.add(candidate);
  }
  return [...found];
}

function keywordHits(keywords, tokens) {
  const hits = [];
  for (const keyword of keywords) {
    const parts = [...tokenize(keyword)];
    if (parts.length && parts.every((part) => tokens.has(part))) hits.push(keyword);
  }
  return hits;
}

function overlap(text, tokens, skip) {
  const hits = [];
  for (const token of tokenize(text)) {
    if (tokens.has(token) && !skip.has(token) && !GENERIC.has(token)) hits.push(token);
  }
  return hits;
}

/**
 * Score one decision against prompt tokens.
 * A decision qualifies on any keyword hit, a mentioned path inside its scope,
 * or at least two distinct non-generic word overlaps.
 */
export function scoreDecision(decision, constraints, tokens, paths = []) {
  const matched = new Set();
  let score = 0;

  const keywords = keywordHits(decision.keywords ?? [], tokens);
  for (const keyword of keywords) {
    score += 3;
    for (const part of tokenize(keyword)) matched.add(part);
  }
  const titleHits = overlap(decision.title, tokens, matched);
  for (const token of titleHits) {
    score += 2;
    matched.add(token);
  }
  const bodyText = [decision.statement, ...constraints.map((c) => c.rule)].join(' ');
  const bodyHits = overlap(bodyText, tokens, matched);
  for (const token of bodyHits) {
    score += 1;
    matched.add(token);
  }

  // A mentioned path counts only for a narrow scope ("src/generated/**"). A broad
  // one ("src/**") would surface the decision for nearly every prompt; those are
  // covered precisely, per file, by the PreToolUse reminder instead.
  let pathHit = null;
  const narrow = (decision.scope ?? []).filter((glob) => !glob.startsWith('!') && literalDepth(glob) >= 2);
  if (narrow.length) {
    pathHit = paths.find((p) => matchesScope(p, narrow) && matchesScope(p, decision.scope)) ?? null;
    if (pathHit) score += 3;
  }

  const qualifies = keywords.length > 0 || pathHit !== null || (matched.size >= 2 && score >= 3);
  return { score, qualifies, matched: [...matched], path: pathHit };
}

/** Number of leading path segments of a glob that contain no wildcard. */
function literalDepth(glob) {
  let depth = 0;
  for (const segment of normalizePath(glob).split('/')) {
    if (/[*?[\]{}]/.test(segment)) break;
    depth++;
  }
  return depth;
}

export function scoreAlternative(alternative, tokens) {
  const matched = new Set();
  let score = 0;
  const keywords = keywordHits(alternative.keywords ?? [], tokens);
  for (const keyword of keywords) {
    score += 3;
    for (const part of tokenize(keyword)) matched.add(part);
  }
  for (const token of overlap(alternative.title, tokens, matched)) {
    score += 2;
    matched.add(token);
  }
  return { score, qualifies: keywords.length > 0 || matched.size >= 2, matched: [...matched] };
}

/**
 * Find decisions and rejected ideas relevant to a piece of text.
 * @returns {{ decisions: object[], alternatives: object[] }}
 */
export function findRelevant(ctx, text, options = {}) {
  const limit = options.limit ?? ctx.config.context?.promptMatches ?? 3;
  const statuses = options.statuses ?? ['active'];
  const tokens = tokenize(text);
  const paths = extractPaths(text);
  if (!tokens.size && !paths.length) return { decisions: [], alternatives: [] };

  const decisions = [];
  for (const decision of ctx.store.decisions.list({ status: statuses })) {
    const constraints = ctx.store.constraints.listByDecision(decision.id);
    const result = scoreDecision(decision, constraints, tokens, paths);
    if (result.qualifies) decisions.push({ decision, constraints, ...result });
  }
  decisions.sort((a, b) => b.score - a.score || a.decision.id.localeCompare(b.decision.id));

  const alternatives = [];
  for (const alternative of ctx.store.alternatives.list({ status: 'rejected' })) {
    const result = scoreAlternative(alternative, tokens);
    if (result.qualifies) alternatives.push({ alternative, ...result });
  }
  alternatives.sort((a, b) => b.score - a.score || a.alternative.id.localeCompare(b.alternative.id));

  return { decisions: decisions.slice(0, limit), alternatives: alternatives.slice(0, limit) };
}

const DECISION_LANGUAGE = [
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bwe(?:'ve| have)? (?:decided|agreed)\b/i,
  /\b(?:the )?decision is\b/i,
  /\blet'?s (?:standardi[sz]e on|stick (?:with|to)|settle on|commit to)\b/i,
  /\b(?:we|you|claude) (?:must|should|will|shall) (?:always|never)\b/i,
  /\b(?:always|never) (?:use|introduce|add|modify|change|touch|call|access|import|store|write|bypass)\b/i,
  /\b(?:as a|project|team|house) (?:rule|policy|convention|standard)\b/i,
  /\b(?:is|are) (?:off[- ]limits|forbidden|not allowed|prohibited)\b/i,
  /\bmust (?:never|not|always) be\b/i,
  // Azerbaijani
  /\bbundan sonra\b/i,
  /\bqərara (?:gəldik|aldıq)\b/i,
  /\b(?:heç vaxt|həmişə)\b.{0,60}\b(?:istifadə|toxun|dəyiş|əlavə)/i,
];

/** Does this prompt read like the developer stating a durable engineering decision? */
export function looksLikeDecision(text) {
  const value = String(text ?? '');
  if (value.length < 12 || value.length > 4000) return false;
  if (value.trimStart().startsWith('/')) return false; // slash commands handle themselves
  return DECISION_LANGUAGE.some((pattern) => pattern.test(value));
}
