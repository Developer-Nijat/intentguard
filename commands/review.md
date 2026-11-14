---
description: Review recorded decisions for drift — re-affirm, update, supersede or retire them
argument-hint: "[DEC-0001]"
---

# Review decisions

The IntentGuard CLI is `node "${CLAUDE_PLUGIN_ROOT}/bin/intentguard.js"` — written below as `intentguard`.

Decisions age. This command finds the ones that no longer match reality so the developer can deal with them deliberately.

If `$ARGUMENTS` names a decision, go straight to step 2 for that decision (`intentguard why <DEC>` to load it).

## 1. Find drift

Run `intentguard review`. It flags active decisions with signals such as:

- `violated_in_code` — the codebase already contradicts a constraint (the code drifted, or the decision is outdated)
- `evidence_changed` / `evidence_missing` — the document the decision was based on changed or is gone
- `scope_empty` — nothing matches the decision's scope any more
- `repeated_conflicts`, `many_exceptions` — the decision keeps getting in the way
- `stale` — not looked at for a long time

It also lists *proposed* decisions still waiting for the developer's confirmation, and expired exceptions.

## 2. Walk through them

Take the flagged decisions one at a time, most serious first. For each: state the decision and its recorded reason, explain the signal in plain words, and — where it helps — look at the evidence file or the contradicting code so the developer has facts, not just a flag. Then ask what they want:

| Outcome | Command |
| --- | --- |
| Still right — keep it | `intentguard review --keep <DEC>` (re-verifies evidence, resets staleness) |
| Right idea, details changed | `intentguard update <DEC> --reason "..." --scope "..." --note "<what changed>"` |
| Replaced by a different decision | `intentguard supersede <DEC> --input <new.json> --confirmed` (old one is kept in history, linked to its successor) |
| No longer applies | `intentguard deprecate <DEC> --note "<why>"` |
| A constraint is wrong or too broad | `intentguard constraint remove <CON>` / `intentguard constraint add <DEC> --rule "..."` |
| Proposed decision: approve / drop | `intentguard confirm <DEC>` / `intentguard deprecate <DEC>` |

Give your view when asked, with reasons — but the outcome is the developer's call. Never update, supersede or retire a decision without their explicit answer.

Finish with a one-line summary of what changed.
