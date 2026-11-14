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
import { DATA_DIR } from '../core/project.js';
import { caseInsensitivePlatform } from '../core/scope-matcher.js';

/** After `$`, these start an expansion or a quoting form; anything else leaves `$` literal. */
const EXPANSION_UNQUOTED = /[A-Za-z_0-9@*#?\-$!({'"^:]/;
const EXPANSION_IN_DOUBLE_QUOTES = /[A-Za-z_0-9@*#?\-$!({^:]/;
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
const CLI_NAMES = new Set(['intentguard', 'intentguard.js', 'intentguard.cmd']);

/**
 * If argv is an invocation of the IntentGuard CLI (`intentguard …` or
 * `node <path>/intentguard.js …`), return the CLI's own arguments; else null.
 */
export function ownCliArgs(argv) {
  if (!argv?.length) return null;
  const start = /^node(?:\.exe)?$/.test(baseName(argv[0])) ? 1 : 0;
  if (argv[start] === undefined || !CLI_NAMES.has(baseName(argv[start]))) return null;
  return argv.slice(start + 1);
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
const READ_ONLY = new Set([
  'cat', 'ls', 'dir', 'type', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'rg', 'findstr', 'wc', 'stat', 'file', 'tree', 'du',
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'gi', 'test-path', 'select-string', 'sls', 'get-filehash', 'resolve-path',
]);
const GIT_READ_OR_RECORD = new Set(['add', 'status', 'diff', 'log', 'show', 'ls-files', 'check-ignore', 'blame', 'commit']);

function isHarmlessToDataDir(argv) {
  if (!argv) return false;
  const tool = baseName(argv[0]).replace(/\.exe$/, '');
  if (READ_ONLY.has(tool)) return true;
  return tool === 'git' && GIT_READ_OR_RECORD.has((argv[1] ?? '').toLowerCase());
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

  const { command, shell } = call;
  const weakeningReason = (action) =>
    `IntentGuard: "intentguard ${action.replace(/\s+/g, ' ')}" changes what IntentGuard enforces (resolving conflicts, granting exceptions, altering or retiring decisions). That choice is yours — approve only if this is your decision.`;

  const argv = parseSimpleCommand(command, shell);
  const cliArgs = ownCliArgs(argv);
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
export function isOwnCliOnly(command, shell = 'bash') {
  return ownCliArgs(parseSimpleCommand(command, shell)) !== null;
}
