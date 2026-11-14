/**
 * Evidence resolution: every decision should point at something that backs it
 * up. For file evidence we remember a content hash, so we can tell later when
 * the source a decision was based on has changed or disappeared.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { commitExists } from './git.js';

const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

/** Hash text with line endings normalised, so CRLF/LF checkouts agree. */
export function hashContent(text) {
  return createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');
}

/** Strip "#anchor" and ":12-40" suffixes from an evidence source to get the file. */
export function evidenceFilePath(source) {
  return String(source)
    .replace(/#.*$/, '')
    .replace(/:\d+(?:-\d+)?$/, '')
    .trim();
}

/** Hash a project file. Returns null when it is missing, outside the project, or not a regular file. */
export function hashFile(root, source) {
  const absolute = path.resolve(root, evidenceFilePath(source));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) return null;
    return hashContent(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return null;
  }
}

/** Compute the verification stamp to store when evidence is recorded or re-verified. */
export function stampEvidence(root, evidence, now = new Date().toISOString()) {
  if (evidence.kind === 'file') {
    const contentHash = hashFile(root, evidence.source);
    return { contentHash, verifiedAt: contentHash ? now : null };
  }
  if (evidence.kind === 'commit') {
    return { contentHash: null, verifiedAt: commitExists(root, evidence.source) ? now : null };
  }
  return { contentHash: null, verifiedAt: null };
}

/**
 * Current state of a piece of evidence.
 *   verified      the source exists and is unchanged since it was verified
 *   changed       the file changed after the decision was verified against it
 *   missing       the file / commit no longer exists
 *   unverified    never successfully verified (e.g. file did not exist when recorded)
 *   unverifiable  IntentGuard cannot check this kind (URL, conversation, note)
 */
export function resolveEvidence(root, evidence) {
  if (evidence.kind === 'file') {
    const current = hashFile(root, evidence.source);
    if (current === null) return { state: 'missing', currentHash: null };
    if (!evidence.contentHash) return { state: 'unverified', currentHash: current };
    return { state: current === evidence.contentHash ? 'verified' : 'changed', currentHash: current };
  }
  if (evidence.kind === 'commit') {
    const found = commitExists(root, evidence.source);
    if (found === null) return { state: 'unverifiable', currentHash: null };
    return { state: found ? 'verified' : 'missing', currentHash: null };
  }
  return { state: 'unverifiable', currentHash: null };
}
