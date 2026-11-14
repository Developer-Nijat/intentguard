---
description: Record an engineering decision — what was decided, why, and where it applies
argument-hint: "<decision, reason and scope in your own words>"
---

# Record a decision

The IntentGuard CLI is `node "${CLAUDE_PLUGIN_ROOT}/bin/intentguard.js"` — written below as `intentguard`.

The developer wants to record this:

$ARGUMENTS

If that is empty, record the decision that was just made in this conversation; if it is unclear which one, ask.

## 1. Structure it

Turn the developer's words into one record. Use their wording; do not embellish.

| Field | Notes |
| --- | --- |
| `title` | Short and specific, e.g. "Use RabbitMQ for async communication". |
| `decision` | What was decided, one or two sentences. |
| `reason` | **Why.** Required. If the developer gave none, ask one question to get it. Never invent a reason. |
| `scope` | Glob patterns relative to the project root (`services/**`, `apps/web/**`, `*.sql`). Omit for a project-wide decision. |
| `type` | `architectural`, `technical`, `business`, `process`, `security` or `convention`. |
| `source` | `developer` when they stated it; `document` when it comes from a file; `git` when inferred from history; `claude` when it is your own suggestion. Be honest — these are never mixed. |
| `constraints` | The hard rules that follow from the decision. Each has `rule`, `kind` (`must` / `must_not`), `severity` (`low`…`critical`). |
| `evidence` | Where this is written down: `{ "source": "docs/architecture.md", "locator": "section 3" }`. A file path, URL or commit. Omit if there is none. |
| `alternatives` | Options that were considered and rejected: `{ "title": "...", "reason": "why it was rejected" }`. |

**Detectors (optional).** A constraint can carry mechanical detectors so hooks can catch violations as they happen:

- `patterns`: JavaScript regexes matched against text being written inside the scope, e.g. `"from ['\"]redux['\"]"`. Prefix with `(?i)` for case-insensitive.
- `commandPatterns`: regexes matched against shell commands, e.g. `"npm (i|install) .*\\bredux\\b"`.
- `protect: true`: any modification inside the constraint's scope is a violation (generated files, legacy modules).

Add a detector only when a precise one exists. A constraint without detectors is still valuable: it is shown to Claude whenever the area is touched and judged semantically. A sloppy regex produces false positives, which erode trust.

Never put secrets, tokens, passwords or connection strings in any field — IntentGuard rejects them.

## 2. Confirm

Show the record compactly (title, decision, reason, scope, constraints with any detectors, evidence, rejected alternatives) and ask the developer to confirm or correct it. One round; keep it quick.

## 3. Save

After an explicit yes, write the JSON to a temporary file (your scratchpad directory, not the project) and run:

```
intentguard add --input <file.json> --confirmed
```

Simple decisions can skip the file:

```
intentguard add --title "..." --decision "..." --reason "..." --scope "services/**" --must-not "..." --confirmed
```

If the developer wants to think about it, save without `--confirmed`: it is stored as *proposed*, is not enforced, and can be approved later with `intentguard confirm <DEC>`.

Report the new ID in one line. If the CLI says a decision with that title exists, show the existing one (`intentguard why <ID>`) and ask whether to update or supersede it.

Example JSON:

```json
{
  "title": "Use RabbitMQ for async communication",
  "decision": "Services communicate asynchronously through RabbitMQ.",
  "reason": "Services must remain loosely coupled and failures isolated.",
  "type": "architectural",
  "source": "developer",
  "scope": ["services/**"],
  "constraints": [
    { "rule": "No direct synchronous HTTP calls between services", "kind": "must_not", "severity": "high" }
  ],
  "evidence": [{ "source": "docs/architecture.md", "locator": "section 3" }],
  "alternatives": [{ "title": "Direct REST calls between services", "reason": "Couples service availability" }]
}
```
