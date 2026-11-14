# Concepts

IntentGuard stores six kinds of record. All of them live in one local SQLite file, `.intentguard/intentguard.db`.

## Decision

What was decided, why, and where it applies.

| Field | Meaning |
| --- | --- |
| `id` | `DEC-0001`, assigned in order. Loose forms (`dec-1`) are accepted everywhere. |
| `title` | Short name. Unique among live decisions. |
| `decision` | The statement itself. |
| `reason` | **Why.** Required — a decision without its reason cannot be weighed against a new situation. |
| `type` | `architectural`, `technical`, `business`, `process`, `security`, `convention`. |
| `scope` | Glob patterns for the files it governs. Empty means the whole project. |
| `keywords` | Words that should bring this decision up when they appear in a request. Derived from the title if omitted. |
| `source` | Where it came from (below). |
| `status` | Lifecycle (below). |

### Provenance

`source` is one of four values, and they are never merged or silently upgraded:

| Source | Meaning |
| --- | --- |
| `developer` | The developer stated it. |
| `document` | Extracted from a file in the project (an ADR, `CLAUDE.md`, architecture docs). |
| `git` | Inferred from history. |
| `claude` | Suggested by Claude. |

Provenance is separate from confirmation. A decision suggested by Claude and approved by the developer keeps `source: claude` forever — and becomes `active`.

### Lifecycle

```
proposed ──confirm──▶ active ──deprecate──▶ deprecated
                        │  ▲                    │
                        │  └────reactivate──────┘
                        └──supersede──▶ superseded (linked to its successor)
```

- **proposed** — recorded but not confirmed by the developer. Shown, never enforced.
- **active** — confirmed. Only active decisions are checked.
- **superseded** — replaced by another decision; the link is kept so the history reads "we used to do X, now Y, because Z".
- **deprecated** — no longer applies.

Editing a decision in place (`update`) bumps its revision and stores a before/after diff. Nothing is ever deleted except by `purge`.

## Constraint

A hard rule that follows from a decision. This is where *negative knowledge* lives.

| Field | Meaning |
| --- | --- |
| `rule` | The rule in words: "No MongoDB driver in the frontend". |
| `kind` | `must_not` (default) or `must`. |
| `severity` | `low`, `medium`, `high`, `critical`. Orders the session briefing. |
| `enforcement` | `observe`, `warn` or `enforce`. Omit to inherit the project default. |
| `scope` | Optional override of the decision's scope — narrow it, or exclude paths with `!`. |
| `patterns` | Optional regexes matched against text being written. |
| `commandPatterns` | Optional regexes matched against shell commands. |
| `protect` | `true`: any modification inside the scope is a violation. |

A constraint with no detector is still useful. It is shown to Claude at session start, when a request mentions its subject, and the first time a governed file is edited — and judged semantically.

## Evidence

Where the decision is written down: a file (with optional section or line range), a URL, a commit, or a note.

For a **file**, IntentGuard stores a hash of its content when the evidence is recorded. Later it can report the evidence as:

| State | Meaning |
| --- | --- |
| verified | The file exists and is unchanged. |
| changed | The file changed since it was verified. Read it again: does the decision still hold? |
| missing | The file is gone. |
| unverified | It did not exist when recorded. |
| unverifiable | A URL, conversation or note — IntentGuard does not pretend to check these. |

A decision with no evidence is allowed; it is reported as "stated by the developer on <date>".

## Rejected idea

Something that was considered and turned down, with the reason. It can belong to a decision ("we chose RabbitMQ; Kafka was rejected because…") or stand alone ("Redis for sessions: rejected, ops will not run another stateful service").

When a request mentions a rejected idea, Claude is shown the earlier rejection before it plans. The idea may still be chosen this time — knowingly.

## Conflict

A record that a change ran into a decision. Created by a hook or by `check`.

| Field | Meaning |
| --- | --- |
| `id` | `CONF-0001`. |
| `decisionId`, `constraintId` | What it ran into. |
| `description`, `filePath`, `excerpt` | What was detected and where. |
| `verdict`, `confidence` | `potential_conflict` (0.8, a pattern matched) or `confirmed_violation` (1.0, a protected path). |
| `status` | `pending`, `resolved` or `dismissed`. |
| `occurrences` | Number of sessions in which it was seen. |

A conflict is identified by *constraint + file + detector*, so editing the same file ten times produces one record, not ten.

### Resolving

The developer chooses one of four outcomes:

| Resolution | Effect |
| --- | --- |
| `kept` | The decision stands; the change is adjusted. If the same conflict reappears later, it reopens. |
| `decision_updated` | The decision itself is being changed. |
| `exception_granted` | Allowed here. Creates an exception. |
| `false_positive` | The detector was wrong. Never raised again. |

## Exception

An explicit, explained permission to deviate from a decision in one place.

| Field | Meaning |
| --- | --- |
| `reason` | Required. |
| `scope` | Where it applies. Empty means the whole decision. |
| `constraintId` | Optional: only this constraint. |
| `expiresAt` | Optional. After it passes, the code is checked again and `review` reports the expiry. |

Two or more exceptions in force on one decision is a drift signal: a rule with many exceptions may no longer be the real rule.

## Verdicts

Every comparison of a change with the decisions ends in one of four verdicts:

| Verdict | Meaning |
| --- | --- |
| **compatible** | Nothing recorded governs this change, or every detector is clean. |
| **unknown** | A decision governs this area but cannot be checked mechanically. Insufficient evidence — a judgement is needed. |
| **potential conflict** | A detector matched. Intent still needs confirming. |
| **confirmed violation** | A protected path was modified. |

`unknown` exists so that "we could not check" is never reported as "it is fine".

## Enforcement

| Mode | A conflict… |
| --- | --- |
| `observe` | …is recorded. Nothing is said. |
| `warn` | …is recorded, and Claude is told to stop and ask the developer. The tool call is not blocked. |
| `enforce` | …is recorded, and the tool call needs the developer's approval in the permission prompt. An approval holds for the rest of the session; it does not resolve the conflict. |

The default is `warn`. IntentGuard does not block every inconsistency — a developer moving from RabbitMQ to HTTP is not making a mistake; the old decision simply has to be changed on purpose.

## Drift

`review` examines every active decision and reports signals that it has drifted from reality:

| Signal | Meaning |
| --- | --- |
| `violated_in_code` | Files in the codebase already match a constraint's patterns. Either the code drifted or the decision is out of date. |
| `evidence_changed`, `evidence_missing` | The source the decision rests on changed or disappeared. |
| `scope_empty` | No file matches the scope any more. |
| `repeated_conflicts` | Work has run into this decision three or more times (counted per session, not per edit). |
| `many_exceptions` | Two or more exceptions are in force. |
| `stale` | Not reviewed for `review.staleAfterDays` (default 180). |

Each is a question for the developer, never an automatic change.
