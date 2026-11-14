---
name: decision-capture
description: Use when the developer makes, confirms or reverses a durable engineering decision in conversation — choosing a technology or architecture, setting a rule ("never X", "always Y", "from now on"), declaring an area off-limits, or rejecting a proposed approach — in a project that uses IntentGuard (.intentguard/ exists). Also use when an IntentGuard note says a message may state a decision.
---

# Capturing decisions

IntentGuard keeps a project's engineering decisions — what was decided, **why**, and where it applies — so they survive across sessions. Your part is to notice when a decision is made and offer to record it. The developer decides; you never record on their behalf.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/intentguard.js"` (written `intentguard` below).

## What is worth recording

Record things a future session would get wrong without being told:

- An architectural or technology choice with a reason ("RabbitMQ between services, for failure isolation")
- A hard constraint or piece of negative knowledge ("the frontend never talks to the database", "do not add another logging library", "generated files are not edited by hand")
- A rejected approach and why it was rejected ("we looked at Redis for this; rejected because ops will not run another stateful service")
- A reversal of an earlier decision

Do not record: one-off instructions for the current task, personal style preferences better kept in CLAUDE.md, facts already obvious from the code, or anything the developer has not actually decided yet.

## Procedure

1. **Finish the work first.** Offer at a natural pause, in one sentence: *"That sounds like a lasting decision — want me to record it in IntentGuard?"* If they decline, drop it and do not ask again for the same thing.
2. **Check for an existing record**: `intentguard why "<topic>"`. If one exists, this is an update or a reversal — use the `decision-review` skill instead of creating a duplicate.
3. **Structure and confirm** following `/intentguard:remember`: title, decision, reason, scope, constraints, evidence, rejected alternatives. Show it; get an explicit yes.
4. **Save** with `intentguard add --input <file.json> --confirmed`.

## Rules that matter

- **The reason is the point.** If the developer did not say why, ask. Do not supply a plausible-sounding reason of your own; a wrong "why" is worse than none.
- **Provenance is honest.** `source` is `developer` only when they stated it. Something you inferred from documents is `document`, from history `git`, your own idea `claude`. Unconfirmed records are saved without `--confirmed` and stay *proposed* (not enforced).
- **A rejected idea alone is fine.** `intentguard reject --title "Redis for session storage" --reason "..."` records it without a decision; add `--decision <DEC>` when it belongs to one.
- **No secrets** in any field.
- **Stay brief.** Capturing a decision should take the developer seconds, not a conversation.
