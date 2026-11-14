# Reference

## Command line

While the plugin is enabled, `intentguard` is on the PATH of Claude's shell. From a clone: `node bin/intentguard.js`.

Common options: `--json` (machine-readable output), `--project <dir>` (run against another directory), `--actor <name>` and `--session <id>` (recorded in the history).

Exit codes: `0` success · `1` a `check --fail-on` threshold was reached, or an unexpected error · `2` invalid usage or input · `3` the project is not initialised.

### Setup

| Command | |
| --- | --- |
| `intentguard init [--enforcement observe\|warn\|enforce]` | Create `.intentguard/`. Uses the git root when run inside a repository. Idempotent. |
| `intentguard status` | Counts, enforcement mode, database location. |

### Decisions

| Command | |
| --- | --- |
| `intentguard add --input <file.json\|-> [--confirmed]` | Record a decision from JSON ([format](#decision-json)). `-` reads stdin. |
| `intentguard add --title T --decision D --reason R [options] [--confirmed]` | Record from flags: `--scope G` (repeatable), `--type`, `--source`, `--keyword K` (repeatable), `--must-not RULE`, `--must RULE`, `--evidence SRC`, and for a single rule `--pattern RE`, `--command-pattern RE`, `--protect`, `--severity`, `--enforcement`. |
| `intentguard confirm <DEC>...` | Approve a proposed decision. |
| `intentguard list [--status S\|all] [--type T] [--path FILE]` | Active and proposed by default. `--path` shows only decisions governing that file. |
| `intentguard why <ID \| path \| text>` | A record by ID (`DEC`, `CON`, `CONF`, `ALT`, `EXC`, `EVD`), the decisions governing a file, or a keyword search. |
| `intentguard update <DEC> [fields] [--note N]` | Edit in place; bumps the revision. Nested constraints, evidence and alternatives in `--input` are added. |
| `intentguard supersede <DEC> --input <file.json\|-> [--confirmed]` | Replace with a new decision; the old one is linked to it. |
| `intentguard deprecate <DEC> [--note N]` · `intentguard reactivate <DEC>` | Retire / restore. |

Without `--confirmed`, a decision is saved as **proposed** and is not enforced.

### Constraints, evidence, rejected ideas

| Command | |
| --- | --- |
| `intentguard constraint add <DEC> --rule R [--kind] [--severity] [--enforcement] [--scope G]... [--pattern RE]... [--command-pattern RE]... [--protect]` | |
| `intentguard constraint remove <CON>` | |
| `intentguard evidence add <DEC> --source <path\|url\|sha> [--locator L] [--description D]` | |
| `intentguard reject --title T --reason R [--decision DEC] [--keyword K]...` | Remember a rejected idea. |
| `intentguard rejected` | List rejected ideas. |

### Verification

| Command | |
| --- | --- |
| `intentguard check` | Working tree against `HEAD`, plus untracked files. Only **added lines** are judged. |
| `intentguard check --staged` · `intentguard check --base <ref>` | The index / a branch diff. |
| `intentguard check <file>...` | Those files, in full. Works without git. |
| `intentguard check --plan "<text>"` | Compare an intention with recorded decisions before code exists. |
| `--dry-run` | Do not record conflicts. |
| `--fail-on <verdict>` | Exit `1` when the verdict is at least `unknown`, `potential_conflict` or `confirmed_violation`. |
| `intentguard conflicts [--status pending\|resolved\|dismissed\|all]` | |
| `intentguard resolve <CONF> --as kept\|updated\|exception\|false-positive [--note N] [--scope G]... [--expires DATE]` | `exception` requires `--note`; its scope defaults to the conflicting file. |
| `intentguard exception add <DEC> --reason R [--scope G]... [--constraint CON] [--expires DATE]` | |
| `intentguard exception list` · `intentguard exception revoke <EXC>` | |
| `intentguard review` | Drift report. |
| `intentguard review --keep <DEC>...` | Reviewed and still right: re-verifies evidence, resets staleness. |
| `intentguard history [DEC] [--limit N]` | Audit trail, newest first. |

### Data

| Command | |
| --- | --- |
| `intentguard export [--out FILE] [--stdout] [--full]` | Decisions as JSON, by default to `.intentguard/decisions.json`. `--full` adds conflicts and history. |
| `intentguard import <FILE>` | Adds decisions that do not exist yet. Never overwrites. |
| `intentguard purge --yes` | Delete `.intentguard/` entirely. |

## Decision JSON

```json
{
  "title": "Use RabbitMQ for async communication",
  "decision": "Services communicate asynchronously through RabbitMQ.",
  "reason": "Services must remain loosely coupled and failures isolated.",
  "type": "architectural",
  "source": "developer",
  "scope": ["services/**"],
  "keywords": ["rabbitmq", "http", "synchronous"],
  "constraints": [
    {
      "rule": "No synchronous HTTP client between services",
      "kind": "must_not",
      "severity": "high",
      "enforcement": "warn",
      "scope": ["services/**", "!services/gateway/**"],
      "patterns": ["from ['\"](axios|node-fetch|got)['\"]"],
      "commandPatterns": [],
      "protect": false
    }
  ],
  "evidence": [{ "source": "docs/architecture.md", "locator": "section 3", "description": "Service communication" }],
  "alternatives": [{ "title": "Direct REST calls", "reason": "Couples service availability" }]
}
```

Required: `title`, `decision`, `reason`. Everything else is optional. Accepted aliases: `statement` for `decision`, `rationale` for `reason`, `tags` for `keywords`.

Limits: title 200 characters, decision 2000, reason 4000, rule 500, 20 patterns per constraint of 500 characters each.

The export format (`intentguard/v1`) is `{ "format", "exportedAt", "decisions": [...], "rejectedIdeas": [...] }`, where each decision is the object above plus `id`, `status`, `revision`, timestamps and `exceptions`.

## Scope patterns

Globs relative to the project root, gitignore-flavoured.

| Pattern | Matches |
| --- | --- |
| `services/**` | Everything under `services/`. |
| `apps/web/**/*.tsx` | Any `.tsx` at any depth below `apps/web`. |
| `apps/*/db/**` | `*` stays within one path segment. |
| `*.sql` | No slash: matches the file name at any depth. |
| `src/generated/` | Trailing slash: the whole directory. |
| `{apps,packages}/*/db/**` | Brace alternation. |
| `src/file-[abc].js`, `src/a?.js` | Character class, single character. |
| `!**/*.test.js` | A leading `!` excludes. |

An empty scope — or one with only exclusions — means the whole project. Matching is case-insensitive on Windows. Absolute paths and `..` are rejected.

## Detector patterns

`patterns` and `commandPatterns` are JavaScript regular expression sources.

- Matched with the multi-line flag, so `^` and `$` anchor to lines.
- Prefix with `(?i)` for case-insensitive: `(?i)\bredux\b`.
- `patterns` see the text being **added**: the content of a `Write`, the `new_string` of an `Edit`, the added lines of a diff. Existing code is not re-flagged when a file is touched; `review` is what finds violations already in the codebase.
- `commandPatterns` see the full command string of `Bash` and `PowerShell` calls.
- A pattern that matches the empty string is rejected.

Write narrow patterns. `from ['"]redux['"]` is a good detector; `redux` is not — it fires on comments, notes and commit messages. When no precise pattern exists, leave the constraint without one.

## Configuration

`.intentguard/config.json`:

```json
{
  "version": 1,
  "enforcement": "warn",
  "context": { "sessionDecisions": 12, "promptMatches": 3 },
  "capture": { "suggest": true },
  "review": { "staleAfterDays": 180 }
}
```

| Key | Meaning |
| --- | --- |
| `enforcement` | Default for constraints that do not set their own: `observe`, `warn`, `enforce`. |
| `context.sessionDecisions` | Maximum decisions listed in the session-start briefing. |
| `context.promptMatches` | Maximum decisions surfaced for one prompt. |
| `capture.suggest` | Offer to record a decision when the developer appears to state one. `false` turns off both the hint and the Stop nudge. |
| `review.staleAfterDays` | Age at which an unreviewed decision is flagged. |

## Files

| Path | Commit it? |
| --- | --- |
| `.intentguard/config.json` | Yes. |
| `.intentguard/decisions.json` | Yes — this is how decisions are shared and reviewed. |
| `.intentguard/intentguard.db` (+ `-wal`, `-shm`) | No. Ignored by `.intentguard/.gitignore`. |
| `.intentguard/logs/errors.log` | No. Hook errors are logged here instead of interrupting a session. |
