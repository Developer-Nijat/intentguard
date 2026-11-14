---
name: decision-review
description: Use in a project that uses IntentGuard (.intentguard/ exists) when a recorded decision needs to change or be re-examined — the developer wants to reverse, replace, narrow or retire a decision; a conflict was settled as "update the decision"; a decision's evidence changed; the code has drifted from it; or the same decision keeps causing conflicts and exceptions.
---

# Changing and reviewing decisions

Recorded decisions are not permanent. What IntentGuard protects is that a change of course is **deliberate, explained and traceable** — the old decision stays in history with a link to what replaced it.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/intentguard.js"` (written `intentguard` below).

## Pick the right operation

| Situation | Operation |
| --- | --- |
| Same decision, details refined (wording, reason, scope, keywords) | `intentguard update <DEC> --reason "..." --scope "..." --note "<what changed and why>"` |
| A different decision replaces it (RabbitMQ → HTTP) | `intentguard supersede <DEC> --input <new.json> --confirmed` |
| It simply no longer applies | `intentguard deprecate <DEC> --note "<why>"` |
| The decision stands, but one case is allowed | `intentguard exception add <DEC> --reason "..." --scope "<glob>" [--expires <date>]` |
| A rule is wrong, too broad, or needs a detector | `intentguard constraint remove <CON>` / `intentguard constraint add <DEC> --rule "..." [--pattern ...]` |
| Reviewed and still right | `intentguard review --keep <DEC>` |
| Retired by mistake | `intentguard reactivate <DEC>` |

Prefer **supersede** over **update** when the substance changes: an edited decision loses the visible "we used to do X, now we do Y, because Z". Prefer an **exception** over loosening the rule when the rule is still right in general.

## Procedure

1. Load the current record: `intentguard why <DEC>` and, when history matters, `intentguard history <DEC>`.
2. Establish why it is changing. A superseding decision needs its own reason, and usually the old approach becomes a rejected alternative of the new one — carry it over with the reason it is being left behind.
3. Show the developer the proposed change (old → new) and get an explicit yes.
4. Apply it. For a supersede, write the new decision as JSON (same shape as `/intentguard:remember`) to a temporary file.
5. Check the fallout: `intentguard conflicts` (conflicts on the old decision close automatically when it is superseded or deprecated) and `intentguard review` if code now contradicts the new decision.

## Drift

`intentguard review` reports decisions that no longer match reality. Read each signal as a question for the developer, not a verdict:

- **violated_in_code** — is the code wrong, or the decision out of date? Look at the listed files before asking.
- **evidence_changed** — read the changed document. Does it still support the decision?
- **evidence_missing / scope_empty** — did the thing move, or is the decision obsolete?
- **repeated_conflicts / many_exceptions** — is this rule still the real rule?
- **stale** — a quick "still right?" is enough.

## Never

Do not update, supersede, deprecate or relax a decision on your own judgement — even when you are confident it is outdated. Present the evidence and your recommendation; the developer makes the call.
