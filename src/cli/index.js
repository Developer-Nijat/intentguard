/**
 * `intentguard` command line. This is the single interface used by developers,
 * by Claude (through the plugin's commands and skills) and by the hooks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from '../core/project.js';
import { NotFoundError, ValidationError } from '../core/validation.js';

export const EXIT = { ok: 0, failed: 1, usage: 2, notInitialised: 3 };

export class UsageError extends Error {}
export class NotInitialisedError extends Error {}

const HELP = `IntentGuard — remember decisions, protect engineering intent.

Usage: intentguard <command> [options]

Setup
  init [--enforcement observe|warn|enforce]   Start using IntentGuard in this project
  status                                      Summary of what is recorded

Decisions
  add --title T --decision D --reason R [--scope G]... [--must-not RULE]... [--confirmed]
  add --input <file.json|->  [--confirmed]    Record a decision from JSON (constraints, evidence, alternatives)
  confirm <DEC>                               Developer approves a proposed decision
  list [--status active|proposed|superseded|deprecated|all] [--type T] [--path FILE]
  why <ID | file path | free text>            Show a decision and the reason behind it
  update <DEC> [--title ..] [--decision ..] [--reason ..] [--scope ..] [--input file] [--note ..]
  supersede <DEC> --input <file.json|-> [--confirmed]   Replace a decision with a new one
  deprecate <DEC> [--note ..]                 Retire a decision
  reactivate <DEC>

Constraints, evidence, rejected ideas
  constraint add <DEC> --rule R [--kind must|must_not] [--severity ..] [--enforcement ..]
                 [--pattern REGEX]... [--command-pattern REGEX]... [--protect] [--scope G]...
  constraint remove <CON>
  evidence add <DEC> --source PATH|URL|SHA [--locator ..] [--description ..]
  reject --title T --reason R [--decision DEC] [--keyword K]...   Remember a rejected idea
  rejected                                    List rejected ideas

Verification
  check [FILE...] [--staged] [--base REF] [--dry-run] [--fail-on VERDICT]
  check --plan "what you intend to do"        Compare a plan with recorded decisions
  conflicts [--status pending|resolved|dismissed|all]
  resolve <CONF> --as kept|updated|exception|false-positive [--note ..] [--scope G]... [--expires DATE]
  exception add <DEC> --reason R [--scope G]... [--constraint CON] [--expires DATE]
  exception list | exception revoke <EXC>
  review [--keep DEC]...                      Find decisions that have drifted from reality
  history [DEC] [--limit N]

Data
  export [--out FILE] [--stdout] [--full]     Write decisions as JSON (default .intentguard/decisions.json)
  import <FILE>
  purge --yes                                 Delete all IntentGuard data for this project

Common options: --json (machine-readable output), --project DIR
All data stays in <project>/.intentguard/. Nothing is sent anywhere.`;

export function packageVersion() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/**
 * Run the CLI. Returns the process exit code; output goes through `io`.
 * @param {string[]} argv arguments after the executable
 * @param {{ out?: (text: string) => void, err?: (text: string) => void, cwd?: string }} [io]
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(`${text}\n`));
  const err = io.err ?? ((text) => process.stderr.write(`${text}\n`));
  const cwd = io.cwd ?? process.cwd();
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(HELP);
    return EXIT.ok;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    out(packageVersion());
    return EXIT.ok;
  }
  if (command === 'hook') {
    const { hookMain } = await import('../hooks/index.js');
    await hookMain(rest[0]);
    return EXIT.ok;
  }

  try {
    const { COMMANDS } = await import('./commands.js');
    const handler = COMMANDS[command];
    if (!handler) throw new UsageError(`Unknown command "${command}". Run \`intentguard help\`.`);
    const code = await handler({ args: rest, out, err, cwd });
    return Number.isInteger(code) ? code : EXIT.ok;
  } catch (error) {
    if (error instanceof NotInitialisedError) {
      err(error.message);
      return EXIT.notInitialised;
    }
    if (
      error instanceof UsageError ||
      error instanceof ValidationError ||
      error instanceof NotFoundError ||
      error?.code?.startsWith?.('ERR_PARSE_ARGS')
    ) {
      err(`intentguard: ${error.message}`);
      return EXIT.usage;
    }
    err(`intentguard: unexpected error: ${error?.stack ?? error}`);
    return EXIT.failed;
  }
}

/** Locate the initialised project for a command, or explain how to initialise. */
export function requireRoot(cwd, project) {
  const start = project ? path.resolve(cwd, project) : cwd;
  const root = findProjectRoot(start);
  if (!root) {
    throw new NotInitialisedError(
      `IntentGuard is not initialised in ${start}. Run /intentguard:init (or \`intentguard init\`) in the project first.`,
    );
  }
  return root;
}
