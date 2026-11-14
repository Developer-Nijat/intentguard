# IntentGuard

**Remember decisions. Protect engineering intent.**

IntentGuard is an open-source [Claude Code](https://claude.com/claude-code) plugin that captures a project's engineering decisions — what was decided, **why**, and where it applies — and flags changes that conflict with them before they become technical debt.

It is not general-purpose memory. It is *decision and constraint intelligence* for AI coding agents.

```
You:     Implement direct HTTP communication between OrderService and NotificationService.

Claude:  Before I implement this: it conflicts with DEC-0012 — services communicate
         asynchronously through RabbitMQ (reason: loose coupling and failure isolation;
         evidence: docs/architecture.md, section 3).

         1. Keep the decision — I'll publish an event instead.
         2. Update the decision — if synchronous calls are now acceptable.
         3. Allow an explicit exception for this integration.
         4. Investigate further first.
```

## Why

Months into a project, the agent writing your code no longer knows why things are the way they are. It re-proposes the approach you rejected in March, wires the frontend straight to the database, edits the generated client by hand. Memory tools remember *what happened*. Rule files say *what to do*. Neither records **why a decision was made, where it applies, and under which conditions it may change** — which is exactly what is needed to notice that a change is about to break one.

IntentGuard's rule for itself: **it never decides for you.** Decisions can change. They just cannot change by accident.

## What it does

| | |
| --- | --- |
| **Decision memory** | Structured records: decision, reason, scope, evidence, provenance. Claude proposes; you confirm. Nothing is recorded or enforced without your approval. |
| **Negative knowledge** | Constraints say what must *not* happen — "do not introduce Redux", "generated files are never edited" — each with its reason, scope and source. |
| **Rejected ideas** | Approaches that were considered and turned down, with why. When one is proposed again, the earlier rejection is shown first. |
| **Change-time verification** | Prompts, file edits and shell commands are compared with active decisions. Verdict: *compatible*, *potential conflict*, *confirmed violation*, or *unknown*. |
| **Drift detection** | Flags decisions that no longer match reality: code that already contradicts them, evidence that changed or vanished, empty scopes, rules eroded by exceptions. |

Everything is local. One SQLite file in `.intentguard/`. No server, no API key, no telemetry, **no dependencies**.

## Install

Requires Claude Code and Node.js 22.13 or newer.

```
/plugin marketplace add Developer-Nijat/intentguard
/plugin install intentguard@intentguard
```

Then, in your project:

```
/intentguard:init
```

To try it from a clone without installing: `claude --plugin-dir /path/to/intentguard`.

## Use

| Command | What it does |
| --- | --- |
| `/intentguard:init` | Start using IntentGuard in this project. Offers to pick up decisions already written in `CLAUDE.md`, ADRs or architecture docs. |
| `/intentguard:remember` | Record a decision. Say it in your own words; Claude structures it and asks you to confirm. |
| `/intentguard:why` | Show a decision and its reason — by ID, by file path, or by topic. |
| `/intentguard:check` | Check current changes (or a plan) against recorded decisions. |
| `/intentguard:conflicts` | List conflicts and settle them. |
| `/intentguard:review` | Find decisions that have drifted; keep, update, supersede or retire them. |
| `/intentguard:history` | The audit trail: what changed, when, and who did it. |

Recording a decision takes one message:

```
/intentguard:remember Frontend must never access MongoDB directly. All business operations
have to pass through the backend authorization layer (docs/architecture.md, section 3).
Applies to apps/web.
```

You do not have to remember to run anything else. Once a decision is recorded, the hooks do the watching.

## How it works

Hooks do the cheap, mechanical part — matching paths, patterns and keywords — and put the right record in front of Claude at the right moment. The semantic judgement ("does this change actually violate the intent?") is Claude's, guided by the plugin's skills; the decision about what to do is yours.

| Hook | What happens |
| --- | --- |
| `SessionStart` | Claude is briefed on the active decisions, rejected ideas, and anything pending. |
| `UserPromptSubmit` | Decisions and rejected ideas relevant to the request are surfaced, with reason and evidence — once per session each. |
| `PreToolUse` | An edit or shell command is checked against active constraints. A match becomes a conflict record and a notice; a governed file gets a one-time reminder of the decision behind it. |
| `PostToolUse` | Bookkeeping: touched files, approvals. |
| `Stop` | If you stated something that reads like a lasting decision and nobody offered to record it, Claude asks — once. |

In a project that has not run `/intentguard:init`, every hook returns immediately.

### Enforcement modes

| Mode | Behaviour |
| --- | --- |
| `observe` | Conflicts are recorded silently. |
| `warn` *(default)* | Claude is told, stops, and asks you how to proceed. Nothing is blocked. |
| `enforce` | The change needs your explicit approval in the permission prompt before it runs. |

Set the project default in `.intentguard/config.json`, or per constraint (`"enforcement": "enforce"`).

**The guard guards itself.** In every mode, anything that would weaken what IntentGuard protects needs your approval in the permission prompt: resolving a conflict, granting an exception, updating, superseding or retiring a decision, removing a constraint, changing the enforcement mode, and any edit to `.intentguard/` itself. Claude can propose these; it cannot quietly do them.

### No nagging

- The same conflict is announced once per session, and is one record no matter how often it is seen.
- A conflict you dismiss as a false positive is never raised again.
- An exception you grant is remembered, scoped, and optionally expires.
- Every notice cites a decision ID, the rule, the reason and the evidence — so you can check it rather than trust it.

## A decision record

```json
{
  "title": "Frontend must never access MongoDB directly",
  "decision": "All data access from apps/web goes through the backend API.",
  "reason": "All business operations must pass through the backend authorization layer.",
  "type": "architectural",
  "source": "developer",
  "scope": ["apps/web/**"],
  "constraints": [
    {
      "rule": "No MongoDB driver in the frontend",
      "kind": "must_not",
      "severity": "high",
      "patterns": ["from ['\"]mongo(db|ose)['\"]"],
      "commandPatterns": ["npm (i|install) .*\\bmongo(db|ose)\\b"]
    }
  ],
  "evidence": [{ "source": "docs/architecture.md", "locator": "section 3" }],
  "alternatives": [{ "title": "Realm SDK in the browser", "reason": "Bypasses the authorization layer" }]
}
```

- **`source`** records where a decision came from — `developer`, `document`, `git` or `claude` — and these are never merged. Anything unconfirmed is stored as *proposed* and is not enforced.
- **`patterns` / `commandPatterns` / `protect`** are optional mechanical detectors. A constraint without them still works: it is shown to Claude whenever its area is touched, and judged semantically.
- **`evidence`** pointing at a file is hashed, so IntentGuard can tell you when the document a decision rests on has changed.

Full details: [concepts](docs/concepts.md) · [reference](docs/reference.md) · [architecture](docs/architecture.md).

## Command line

The plugin ships a CLI — the same engine the commands and hooks use. While the plugin is enabled it is on the PATH of Claude's shell as `intentguard`; from a clone, run `node bin/intentguard.js`.

```
intentguard add --title "Do not introduce Redux" --decision "State lives in Zustand." \
                --reason "Two state libraries doubled onboarding cost." \
                --must-not "No Redux packages" --pattern "from ['\"]redux['\"]" --confirmed
intentguard why src/store.ts
intentguard check --base main --fail-on confirmed_violation
intentguard review
intentguard export
```

Run `intentguard help` for everything.

### Sharing decisions with a team, and CI

The database stays on your machine and is git-ignored. To share decisions, export them as reviewable JSON and commit that:

```
intentguard export        # writes .intentguard/decisions.json
```

Teammates run `intentguard import .intentguard/decisions.json` (Claude will point it out at session start). The same file drives a CI check:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: |
    git clone --depth 1 https://github.com/Developer-Nijat/intentguard /tmp/intentguard
    node /tmp/intentguard/bin/intentguard.js init
    node /tmp/intentguard/bin/intentguard.js import .intentguard/decisions.json
    node /tmp/intentguard/bin/intentguard.js check --base origin/main --fail-on confirmed_violation
```

## Privacy

- No source code, prompt or decision ever leaves your machine. There is no network code in this repository.
- No API key, account or telemetry.
- Secrets are refused: a record containing something that looks like a key, token, password or credentialed URL is rejected.
- Your data is yours: `intentguard export --full` writes everything as JSON; `intentguard purge --yes` deletes all of it.

## Accuracy, honestly

The mechanical layer is pattern matching, and pattern matching is wrong sometimes. So it is measured, false positives and false negatives separately, on a labelled corpus that runs with the test suite (`npm run test:accuracy`):

| | Cases | Precision | Recall | False-positive rate | False-negative rate |
| --- | --- | --- | --- | --- | --- |
| Change detection | 30 | 92.3% | 85.7% | 6.3% | 14.3% |
| Prompt relevance | 126 | 92.9% | 92.9% | 0.9% | 7.1% |

The known misses are listed in the corpus with their reasons — a comment quoting a forbidden import is flagged; a dynamic `import()` or a call through the built-in `fetch` slips past a pattern written for static imports. That is why the design never lets a detector have the last word: a miss still reaches Claude as "this file is governed by DEC-…", and a false alarm is dismissed once and stays dismissed.

Hook cost, measured on Windows 11 with Node 22: 65–80 ms per hook call, of which ~45 ms is Node starting up. In a project that is not initialised a hook adds about 2 ms to that start-up.

## Limits

- Hooks cannot understand intent. A constraint with no detector is only as good as Claude's reading of it.
- Detection sees the text being written, not the program: it does not resolve imports, types or call graphs.
- Shell commands are tokenised and matched as text, not executed in a sandbox: a script, an interpreter one-liner or an indirect command (`find . -delete`, `rm -rf .`) can still do anything, including to `.intentguard/` itself.
- IntentGuard is a guard rail for a cooperative agent and an honest developer, not a security boundary.

## Development

```
git clone https://github.com/Developer-Nijat/intentguard
cd intentguard
npm test
claude plugin validate .
```

No install step — there are no dependencies. Tests use Node's built-in runner.

## Roadmap

- Visual dashboard for decisions and conflicts
- Decision candidates inferred from git history
- Multi-agent synchronisation, and adapters for other coding agents (Codex, Cursor)
- A packaged GitHub Action

## License

[MIT](LICENSE)
