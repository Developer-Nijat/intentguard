/**
 * Self-protection: IntentGuard must not be switched off, emptied, or have its
 * conflicts settled by the agent it is watching without the developer seeing it.
 *
 * Shell commands are judged by tokenising them the way the shell would, never
 * by pattern-matching the raw string — quoting tricks (`intentguard "resolve"`,
 * `"it's" && … "'"`) defeat regexes. Whatever cannot be parsed with certainty
 * is treated as not understood, and the caller fails closed.
 *
 * This raises the bar for a sloppy or over-eager agent. It is not a sandbox:
 * a script can still do anything (see "Limits" in the README).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, canonicalWindowsPath, realPath } from '../core/project.js';
import { caseInsensitivePlatform } from '../core/scope-matcher.js';

/** After `$`, these start an expansion or a quoting form; anything else leaves `$` literal. */
const EXPANSION_UNQUOTED = /[A-Za-z_0-9@*#?\-$!({'"^:]/;
const EXPANSION_IN_DOUBLE_QUOTES = /[A-Za-z_0-9@*#?\-$!({^:]/;
/** Smart quotes (U+2018–U+201F), dashes (U+2012–U+2015) and non-ASCII spaces PowerShell treats as syntax; and , @ #. */
const POWERSHELL_AMBIGUOUS = /[\u2018-\u201F\u2012-\u2015\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF,@#]/;
/** Characters cmd.exe re-interprets when arguments pass through a .cmd launcher. */
const CMD_METACHARACTERS = /["&|<>^%!\r\n]/;
/** Unquoted characters that make a command more than one simple invocation, or expand into unknown words. */
const UNQUOTED_SPECIAL = /[;&|<>(){}\n\r*?[\]]/;

/**
 * Tokenise `command` into argv if — and only if — it is a single simple command
 * with fully known words: no separators, pipes, redirection, grouping,
 * substitution, variable expansion, globbing, or unbalanced quotes.
 * Returns null for anything else.
 *
 * @param {string} command
 * @param {'bash'|'powershell'} [shell] PowerShell has no backslash escape; its escape character
 *   is the backtick, which is rejected outright in both shells.
 * @returns {string[] | null}
 */
export function parseSimpleCommand(command, shell = 'bash') {
  const posix = shell !== 'powershell';
  // PowerShell also accepts typographic quotes and dashes as syntax, and gives
  // , @ # a meaning of their own. Rather than mirror all of that, refuse them.
  if (!posix && POWERSHELL_AMBIGUOUS.test(command)) return null;
  const argv = [];
  let word = '';
  let inWord = false;
  let state = 'unquoted';

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (state === 'single') {
      if (ch === "'") state = 'unquoted';
      else word += ch;
      continue;
    }

    if (state === 'double') {
      if (posix && ch === '\\' && next !== undefined) {
        // In double quotes a backslash only escapes $ ` " \ and newline.
        if (next === '\n') {
          i++;
        } else if ('$`"\\'.includes(next)) {
          word += next;
          i++;
        } else {
          word += ch;
        }
        continue;
      }
      if (ch === '`') return null;
      if (ch === '$' && next !== undefined && EXPANSION_IN_DOUBLE_QUOTES.test(next)) return null;
      if (ch === '"') state = 'unquoted';
      else word += ch;
      continue;
    }

    // unquoted
    if (posix && ch === '\\') {
      if (next === undefined) return null;
      if (next !== '\n') {
        word += next;
        inWord = true;
      }
      i++;
      continue;
    }
    if (ch === '`') return null;
    if (ch === '$' && next !== undefined && EXPANSION_UNQUOTED.test(next)) return null;
    if (ch === "'") {
      state = 'single';
      inWord = true;
      continue;
    }
    if (ch === '"') {
      state = 'double';
      inWord = true;
      continue;
    }
    if (UNQUOTED_SPECIAL.test(ch)) return null;
    if (ch === ' ' || ch === '\t') {
      if (inWord) {
        argv.push(word);
        word = '';
        inWord = false;
      }
      continue;
    }
    word += ch;
    inWord = true;
  }

  if (state !== 'unquoted') return null; // unbalanced quotes
  if (inWord) argv.push(word);
  // PowerShell's stop-parsing token changes how the rest of the line is read.
  if (!posix && argv.includes('--%')) return null;
  return argv.length ? argv : null;
}

const baseName = (word) => word.split(/[\\/]/).pop().toLowerCase();
const LAUNCHERS = new Set(['intentguard', 'intentguard.cmd', 'intentguard.js']);

/** The bin/ directory of this very plugin: the only place a path to the CLI may point. */
const OWN_BIN_DIR = realPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin'));

function samePath(a, b) {
  return caseInsensitivePlatform() ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Does this word, written with a path, name a file in this plugin's own bin/ directory? */
function pointsIntoOwnBin(word, cwd) {
  let candidate = word;
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(candidate)) candidate = `${candidate[1]}:${candidate.slice(2)}`;
  let absolute = path.resolve(cwd || process.cwd(), candidate);
  if (process.platform === 'win32') absolute = canonicalWindowsPath(absolute);
  return samePath(path.dirname(realPath(absolute)), OWN_BIN_DIR);
}

/**
 * If argv is an invocation of *this plugin's* CLI, return the CLI's own
 * arguments; else null.
 *
 *   intentguard …                      the launcher, found on PATH
 *   <path>/intentguard[.js|.cmd] …     only if the path is this plugin's bin/
 *   node <path>/intentguard.js …       likewise
 *
 * A file that merely happens to be called intentguard.js is not the CLI. And
 * when the call goes through the Windows .cmd launcher, cmd.exe parses the
 * arguments a second time — so any argument containing a cmd metacharacter
 * makes the result unknowable, and the call is not recognised.
 */
export function ownCliArgs(argv, options = {}) {
  if (!argv?.length) return null;
  const viaNode = /^node(?:\.exe)?$/.test(baseName(argv[0]));
  const word = argv[viaNode ? 1 : 0];
  if (word === undefined) return null;
  const base = baseName(word);
  const hasPath = /[\\/]/.test(word);

  if (viaNode) {
    if (base !== 'intentguard.js' || !pointsIntoOwnBin(word, options.cwd)) return null;
  } else {
    if (!LAUNCHERS.has(base)) return null;
    if (hasPath && !pointsIntoOwnBin(word, options.cwd)) return null;
  }

  const args = argv.slice(viaNode ? 2 : 1);
  const throughCmd = !viaNode && (base === 'intentguard.cmd' || (base === 'intentguard' && options.shell === 'powershell'));
  if (throughCmd && args.some((arg) => CMD_METACHARACTERS.test(arg))) return null;
  return args;
}

const WEAKENING_SUBCOMMANDS = new Set(['resolve', 'deprecate', 'purge', 'update', 'supersede']);

/**
 * Name of the action if these CLI arguments reduce what IntentGuard protects:
 * settling a conflict, granting an exception, changing or retiring a decision,
 * dropping a constraint, re-affirming a drifted decision, changing the mode.
 */
export function weakeningAction(args) {
  const sub = (args[0] ?? '').toLowerCase();
  const second = (args[1] ?? '').toLowerCase();
  if (WEAKENING_SUBCOMMANDS.has(sub)) return sub;
  if (sub === 'exception' && second === 'add') return 'exception add';
  if (sub === 'constraint' && second === 'remove') return 'constraint remove';
  if (sub === 'review' && args.some((arg) => /^--keep(?:=|$)/.test(arg))) return 'review --keep';
  if (sub === 'init' && args.some((arg) => /^--enforcement(?:=|$)/.test(arg))) return 'init --enforcement';
  return null;
}

/** Remove everything a shell would strip or that could split a word, for a last-resort scan. */
const dequote = (command) => command.replace(/["'\\`^]/g, '');

/** The same actions, searched for in a command we could not parse (compound, substituted…). */
const WEAKENING_IN_TEXT =
  /intentguard(?:\.js|\.cmd)?\s+(resolve|deprecate|purge|update|supersede|exception\s+add|constraint\s+remove|review\b[^;&|\n]*--keep|init\b[^;&|\n]*--enforcement)\b/i;

function globSegmentMatches(segment, name) {
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if (ch === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close === -1) source += '\\[';
      else {
        source += `[${segment.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else source += ch.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  try {
    return new RegExp(`^${source}$`, 'i').test(name);
  } catch {
    return true; // cannot tell: assume it might
  }
}

/** Does the command name the data directory, or use a glob that could expand to it? */
export function referencesDataDir(command, shell = 'bash') {
  if (dequote(command).toLowerCase().includes(DATA_DIR)) return true;
  for (const word of command.split(/[\s;&|()<>"'`]+/)) {
    if (!/[*?[]/.test(word)) continue;
    const first = word.replace(/^(?:\.[\\/])+/, '').split(/[\\/]/)[0];
    if (!/[*?[]/.test(first)) continue;
    // Dot-globs (`.*`, `.int*`) in any shell; a bare `*` in PowerShell, where wildcards match dot-names.
    const dotGlob = first.startsWith('.');
    const bareStar = shell === 'powershell' && /^\*+$/.test(first);
    if ((dotGlob || bareStar) && globSegmentMatches(first, DATA_DIR)) return true;
  }
  return false;
}

/** Commands that only read. Anything else that touches the data directory needs approval. */
// Only tools with no way to write a file or run another program, whatever their flags.
// Deliberately absent: tree (-o), rg (--pre), less/more (shell escapes), file (-C), sort (-o), find, sed, awk.
const READ_ONLY = new Set([
  'cat', 'ls', 'dir', 'type', 'head', 'tail', 'grep', 'egrep', 'findstr', 'wc', 'stat',
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'gi', 'test-path', 'select-string', 'sls', 'get-filehash', 'resolve-path',
]);
/** git subcommands that neither write the working tree nor run diff drivers, pagers or hooks. */
const GIT_PLAIN = new Set(['add', 'status', 'ls-files', 'check-ignore']);

function isHarmlessToDataDir(argv) {
  if (!argv) return false;
  const tool = baseName(argv[0]).replace(/\.exe$/, '');
  if (READ_ONLY.has(tool)) return true;
  // git accepts abbreviated long options and can run programs through configuration, so no flag
  // list is trustworthy. Allow only these subcommands, written first, with plain path arguments.
  if (tool !== 'git' || !GIT_PLAIN.has((argv[1] ?? '').toLowerCase())) return false;
  return !argv.slice(2).some((arg) => arg.startsWith('-'));
}

/** `git clean -x` / `-X` removes ignored files — which is exactly where the database lives. */
const GIT_CLEAN_IGNORED = /\bgit\s+clean\b[^;&|\n]*\s-[a-wyzA-WYZ]*[xX]/;

/** Is this project-relative path inside IntentGuard's data directory? */
export function isOwnDataPath(relPath) {
  const p = caseInsensitivePlatform() ? relPath.toLowerCase() : relPath;
  return p === DATA_DIR || p.startsWith(`${DATA_DIR}/`);
}

/**
 * Classify a tool call with respect to IntentGuard's own state.
 * @returns {{ ask: string } | { exempt: true } | null}
 *   ask     the developer must approve; the string is the reason shown to them
 *   exempt  a plain, harmless call of IntentGuard's own CLI — skip command-pattern
 *           matching, since recording a rule quotes the very thing it forbids
 *   null    nothing to do with IntentGuard's own state; evaluate normally
 */
export function classifyOwnState(call) {
  if (call.kind === 'file') {
    if (!call.path || !isOwnDataPath(call.path)) return null;
    return {
      ask: `IntentGuard: this edits IntentGuard's own data (${call.path}) — its configuration and records decide what is enforced. Approve only if you intend this change.`,
    };
  }

  const { command, shell, cwd } = call;
  const weakeningReason = (action) =>
    `IntentGuard: "intentguard ${action.replace(/\s+/g, ' ')}" changes what IntentGuard enforces (resolving conflicts, granting exceptions, altering or retiring decisions). That choice is yours — approve only if this is your decision.`;

  const argv = parseSimpleCommand(command, shell);
  const cliArgs = ownCliArgs(argv, { shell, cwd });
  if (cliArgs) {
    const action = weakeningAction(cliArgs);
    return action ? { ask: weakeningReason(action) } : { exempt: true };
  }

  // Not a plain CLI call. If a weakening CLI action is buried in it, ask.
  const buried = WEAKENING_IN_TEXT.exec(dequote(command));
  if (buried) return { ask: weakeningReason(buried[1]) };

  const dataDirReason = `IntentGuard: this command may modify or delete IntentGuard's own data (${DATA_DIR}/). Approve only if you intend this change.`;
  if (GIT_CLEAN_IGNORED.test(command)) return { ask: dataDirReason };
  if (referencesDataDir(command, shell) && !isHarmlessToDataDir(argv)) return { ask: dataDirReason };
  return null;
}

/** For tests and callers that only need the yes/no. */
export function isOwnCliOnly(command, shell = 'bash', cwd = process.cwd()) {
  return ownCliArgs(parseSimpleCommand(command, shell), { shell, cwd }) !== null;
}
