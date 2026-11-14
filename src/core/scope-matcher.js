/**
 * Scope matching: decides whether a project-relative path falls inside a
 * decision's scope.
 *
 * Scope is a list of glob patterns, gitignore-flavoured:
 *   services/**            everything under services/
 *   apps/web/**\/*.tsx     any .tsx below apps/web
 *   *.sql                  no slash => matches the basename at any depth
 *   src/generated/         trailing slash => the whole directory
 *   {apps,packages}/*\/db  brace alternation
 *   !**\/*.test.js         leading "!" excludes
 *
 * An empty scope (or one with only exclusions) means "the whole project".
 */

const REGEX_SPECIAL = /[.+^${}()|[\]\\*?]/g;

function escapeRegex(text) {
  return text.replace(REGEX_SPECIAL, '\\$&');
}

function bracesBalanced(glob) {
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\') {
      i++;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      if (depth === 0) return false;
      depth--;
    }
  }
  return depth === 0;
}

/** Normalise any path to forward slashes with no leading "./" or "/". */
export function normalizePath(input) {
  let p = String(input ?? '').replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/{2,}/g, '/');
  if (p.startsWith('/')) p = p.slice(1);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Translate one glob (without a leading "!") into a regular expression source. */
export function globToRegExpSource(rawGlob) {
  let glob = String(rawGlob).trim().replace(/\\/g, '/');
  while (glob.startsWith('./')) glob = glob.slice(2);
  if (glob.startsWith('/')) glob = glob.slice(1);
  if (glob.endsWith('/')) glob += '**';

  // gitignore rule: a pattern without a slash matches at any depth.
  if (!glob.includes('/')) glob = `**/${glob}`;

  const useBraces = bracesBalanced(glob);
  let source = '';
  let braceDepth = 0;

  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];

    if (c === '*') {
      if (glob[i + 1] === '*') {
        const startsSegment = i === 0 || glob[i - 1] === '/';
        const followedBySlash = glob[i + 2] === '/';
        if (startsSegment && followedBySlash) {
          source += '(?:[^/]+/)*'; // zero or more whole directories
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (c === '?') {
      source += '[^/]';
    } else if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close === -1) {
        source += '\\[';
      } else {
        let body = glob.slice(i + 1, close);
        let negate = '';
        if (body[0] === '!' || body[0] === '^') {
          negate = '^';
          body = body.slice(1);
        }
        source += `[${negate}${body.replace(/[\\\]^]/g, '\\$&')}]`;
        i = close;
      }
    } else if (c === '{' && useBraces) {
      braceDepth++;
      source += '(?:';
    } else if (c === '}' && useBraces && braceDepth > 0) {
      braceDepth--;
      source += ')';
    } else if (c === ',' && braceDepth > 0) {
      source += '|';
    } else if (c === '\\' && i + 1 < glob.length) {
      source += escapeRegex(glob[i + 1]);
      i++;
    } else {
      source += escapeRegex(c);
    }
  }

  return `^${source}$`;
}

/**
 * Platforms whose default filesystem ignores case. There, "Apps/Web/db.js" and
 * "apps/web/db.js" are the same file, so scopes must match both spellings —
 * otherwise changing the case of a path would step around a decision.
 */
export const caseInsensitivePlatform = (platform = process.platform) => platform === 'win32' || platform === 'darwin';

const compiledCache = new Map();

/**
 * Compile a scope (list of globs) into a matcher.
 * @param {string[]} globs
 * @param {{ nocase?: boolean }} [options]
 */
export function compileScope(globs, options = {}) {
  const nocase = options.nocase ?? caseInsensitivePlatform();
  const list = Array.isArray(globs) ? globs : globs ? [globs] : [];
  const key = `${nocase ? 'i' : 's'}\u0000${list.join('\u0000')}`;
  const cached = compiledCache.get(key);
  if (cached) return cached;

  const include = [];
  const exclude = [];
  for (const raw of list) {
    const glob = String(raw ?? '').trim();
    if (!glob) continue;
    const negated = glob.startsWith('!');
    const regex = new RegExp(globToRegExpSource(negated ? glob.slice(1) : glob), nocase ? 'i' : '');
    (negated ? exclude : include).push(regex);
  }

  const matcher = {
    isGlobal: include.length === 0,
    matches(filePath) {
      const p = normalizePath(filePath);
      if (!p) return false;
      if (exclude.some((re) => re.test(p))) return false;
      return include.length === 0 || include.some((re) => re.test(p));
    },
  };
  compiledCache.set(key, matcher);
  return matcher;
}

/** True when `filePath` is inside the scope described by `globs`. */
export function matchesScope(filePath, globs, options) {
  return compileScope(globs, options).matches(filePath);
}

/** Validate a glob; returns an error message or null. */
export function validateGlob(glob) {
  if (typeof glob !== 'string' || !glob.trim()) return 'scope pattern must be a non-empty string';
  if (glob.length > 300) return 'scope pattern is too long (max 300 characters)';
  if (/^[a-zA-Z]:[\\/]/.test(glob) || glob.startsWith('//')) {
    return 'scope patterns must be relative to the project root';
  }
  if (normalizePath(glob.replace(/^!/, '')).split('/').includes('..')) {
    return 'scope patterns may not contain ".."';
  }
  try {
    new RegExp(globToRegExpSource(glob.replace(/^!/, '')));
  } catch (error) {
    return `invalid scope pattern: ${error.message}`;
  }
  return null;
}
