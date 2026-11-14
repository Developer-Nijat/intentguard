# Architecture

```
Claude Code
  user prompt · tool calls · session events
        │
        ▼
IntentGuard plugin
  commands/   7 slash commands            user interface
  skills/     3 model-invoked workflows   capture · verification · review
  agents/     decision-auditor            semantic audit of large changes
  hooks/      5 hook events               mechanical checks, context injection
        │
        ▼   every component calls the same CLI
bin/intentguard.js  →  src/cli
        │
        ▼
src/core
  decision-engine     writes: validation, provenance, audit trail
  conflict-engine     change × constraints → verdict; conflict de-duplication
  scope-matcher       glob → path matching
  evidence-resolver   content hashes; verified / changed / missing
  relevance           keyword matching of prompts to decisions
  drift               signals that a decision no longer matches reality
  check               working-tree / file checks (git-aware)
  transfer            export / import
        │
        ▼
src/storage  →  .intentguard/intentguard.db   (SQLite, local)
```

## Principles

1. **IntentGuard never decides for the developer.** It records, reminds, detects and asks. Every state change that matters — confirming, superseding, granting an exception, dismissing a conflict — is the developer's explicit act. Unconfirmed records are `proposed` and are not enforced.
2. **Hooks are mechanical; judgement is semantic.** A hook cannot know whether a change violates the *intent* of a decision. Hooks match paths, patterns and keywords and put the right record in front of Claude. Claude judges, guided by the skills. This split is why a constraint without a detector still works, and why a detector never has the last word.
3. **"Could not check" is not "fine".** A governed change with no mechanical detector gets the verdict `unknown`, not `compatible`.
4. **A hook must never break a session.** Every hook failure is caught, logged to `.intentguard/logs/errors.log`, and reported as "no output". Hooks always exit 0.
5. **Local only.** No network code. Secrets are rejected at the validation layer.

## Hook flow

All five hooks run `node bin/intentguard.js hook <event>` with the event payload on stdin. The runner first looks for `.intentguard/` above the working directory; if there is none it returns before the database layer is even loaded.

| Event | Handler |
| --- | --- |
| `SessionStart` | Emits a briefing: active decisions (most severe first, capped), rejected ideas, pending conflicts, unconfirmed proposals. After `compact` or `clear` it forgets which reminders were already shown, since Claude has forgotten them too. |
| `UserPromptSubmit` | Runs the relevance matcher over the prompt. Each matching decision or rejected idea is injected once per session. If the prompt reads like a durable decision, adds a capture hint and notes a candidate. |
| `PreToolUse` | For `Write`, `Edit`, `MultiEdit`, `NotebookEdit`: evaluates the text being added against constraints whose scope covers the file. For `Bash` and `PowerShell`: evaluates the command. Findings become conflict records. Output depends on enforcement: nothing (`observe`), a notice as `additionalContext` (`warn`), or `permissionDecision: "ask"` plus the notice (`enforce`). A governed file with no finding gets a one-time reminder of the decision and its reason. |
| `PostToolUse` | If the tool ran after an `ask`, the approval is remembered for the session. Records touched files. |
| `Stop` | If a candidate decision was noted, nothing was recorded since, and Claude's last message did not already offer — blocks the stop once with an instruction to ask the developer. Never re-blocks; capped per session. |

### Self-protection

`PreToolUse` checks three things before it looks at any decision, and answers `permissionDecision: "ask"` in every enforcement mode:

- **Edits to `.intentguard/`** through a file tool — the configuration and records decide what is enforced.
- **CLI commands that weaken protection**: `resolve`, `exception add`, `deprecate`, `purge`, `update`, `supersede`, `constraint remove`, and `init --enforcement`. Read-only and strengthening commands (`why`, `list`, `check`, `add`, `exception revoke`…) pass through.
- **Shell commands that write to or delete `.intentguard/`** (`rm`, redirection, `sed`, `sqlite3`, `Remove-Item`, `Set-Content`…).

IntentGuard's own CLI calls are exempt from command-pattern matching, because recording a rule necessarily mentions what it forbids (`--command-pattern "npm install redux"`). That exemption covers only a single, simple invocation: a command with unquoted `;`, `&`, `|`, redirection, a newline, command substitution, or unbalanced quotes is evaluated in full like any other.

Scope matching ignores case on Windows and macOS, where the filesystem does, so re-casing a path cannot step around a scope.

### Why warnings do not repeat

- **Per conflict:** a conflict's identity is a fingerprint of *constraint + file + detector*. Repeat sightings update one record.
- **Per session:** `session_events` remembers what a session has been told (`notified`, `shown`, `prompt`) and approved (`approved`).
- **Forever:** a conflict resolved as `false_positive` is suppressed permanently; an exception removes the finding at the source.

## Data model

Schema version 1 (`PRAGMA user_version`), migrations in `src/storage/migrations.js`.

| Table | Holds |
| --- | --- |
| `decisions` | The decision, its scope, keywords, status, provenance, revision, `superseded_by`. |
| `constraints` | Rules of a decision, with detectors and optional own scope and enforcement. |
| `evidence` | Sources, with content hash and verification time. |
| `alternatives` | Rejected ideas, optionally linked to a decision. |
| `conflicts` | De-duplicated by `fingerprint`; status, resolution, occurrence count. |
| `exceptions` | Scoped, explained, optionally expiring, revocable. |
| `history` | Append-only audit trail: entity, action, actor, session, summary, before/after. |
| `session_events` | Per-session hook bookkeeping; pruned after 30 days. |
| `counters` | Sequential IDs per prefix. |

Multi-row writes run in `BEGIN IMMEDIATE` transactions. The database uses WAL so that parallel hook processes can read while one writes, with a 4-second busy timeout.

## Deliberate departures from the first concept

The initial design named `better-sqlite3`, Zod, Commander, `simple-git` and Vitest. The implementation uses none of them:

| Planned | Used | Why |
| --- | --- | --- |
| `better-sqlite3` | `node:sqlite` (built in) | Claude Code installs a plugin by cloning its repository; there is no `npm install` step, and a native addon would need a compiler toolchain on every user's machine. |
| Zod | `src/core/validation.js` | Same reason: no dependency may be required at runtime. |
| Commander | `node:util.parseArgs` | Same. |
| `simple-git` | `child_process` + the `git` executable | Same. |
| Vitest | `node:test` | Keeps `npm test` working on a fresh clone with nothing installed. |

The cost is a Node.js floor of 22.13, the first release where `node:sqlite` needs no flag.

Also added beyond the first concept: export/import (planned for a later phase, but needed for the "your data is yours" guarantee and for teams), command-pattern detectors for shell commands, and protected paths.

## Testing

`npm test` runs the suite (about 180 tests) with Node's built-in runner, no install needed.

| Suite | Covers |
| --- | --- |
| `scope-matcher`, `validation` | Glob semantics; input validation; secret detection (and non-detection of ordinary prose). |
| `decision-engine` | Lifecycle, atomicity, provenance, audit trail, exceptions, conflict resolution. |
| `conflict-engine` | The four verdicts, scoping, exceptions, de-duplication, reopen and suppress rules. |
| `relevance` | Tokenisation, keyword and path matching, decision-language detection. |
| `drift`, `check` | Evidence states, every drift signal, added-lines-only diff checks against real git repositories. |
| `hooks` | Each hook event in-process, plus the real executable: clean JSON, empty stderr, exit 0 on garbage input. |
| `cli` | Every command, error paths and exit codes. |
| `transfer` | Export/import round trip, idempotence, atomicity. |
| `plugin` | Manifest consistency; every hook maps to a handler; every CLI command named in the docs exists. |
| `accuracy` | Precision and recall on a labelled corpus, false positives and false negatives counted separately, with a budget that fails the build on regression. |

The accuracy corpus (`tests/fixtures/accuracy-corpus.js`) labels its known misses with the reason. If a change fixes one, the test fails until the label is removed — so the published numbers cannot quietly go stale.
