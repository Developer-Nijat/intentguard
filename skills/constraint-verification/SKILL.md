---
name: constraint-verification
description: Use before planning or implementing a change in a project that uses IntentGuard (.intentguard/ exists) when the request touches an area covered by recorded decisions, and whenever an IntentGuard notice appears in context ("recorded decisions that look relevant", "may conflict with a recorded engineering decision", "is governed by recorded decisions", or a rejected idea being raised again).
---

# Verifying a change against recorded decisions

The project has recorded decisions with reasons. Before you change code, compare what you intend to do with them. The goal is not to block work — decisions can change — it is to make sure a decision is never overridden *by accident*.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/intentguard.js"` (written `intentguard` below).

## Before you start

1. Identify the decisions in play: the session briefing, any IntentGuard notice in context, and `intentguard why <path-or-topic>` for the files or subject you are about to touch. For a non-trivial plan: `intentguard check --plan "<what you intend to do>"`.
2. Read the full record of anything relevant (`intentguard why <DEC>`): the reason, the constraints, exceptions already granted, rejected alternatives.
3. Classify your plan against each one:

| Verdict | When | What you do |
| --- | --- | --- |
| **Compatible** | The plan respects the decision | Proceed. No need to mention it unless useful. |
| **Potential conflict** | It might contradict the decision, depending on intent or detail | Stop and raise it before writing code. |
| **Confirmed violation** | It plainly does what the decision forbids | Stop and raise it before writing code. |
| **Unknown** | You cannot tell from what is recorded | Say what is unclear and ask; do not assume compatibility. |

## Raising a conflict

Say it plainly, with the record attached — ID, the decision, its reason, its evidence — then what in the request collides with it, then the options:

> Before I implement this: it conflicts with **DEC-0012** — *services communicate asynchronously through RabbitMQ* (reason: loose coupling and failure isolation; evidence: docs/architecture.md §3). A direct HTTP call from OrderService to NotificationService would bypass that.
>
> 1. Keep the decision — I'll publish an event instead.
> 2. Update the decision — if synchronous calls are now acceptable.
> 3. Allow an explicit exception for this integration.
> 4. Investigate further first.

Then wait. The developer chooses.

- **Keep** → implement the compliant approach. If a `CONF` record exists: `intentguard resolve <CONF> --as kept`.
- **Update** → use the `decision-review` skill to update or supersede the decision, then implement.
- **Exception** → `intentguard exception add <DEC> --reason "<their reason>" --scope "<glob>"` (or `intentguard resolve <CONF> --as exception --note "<reason>"`), then implement.
- **Investigate** → gather what is needed and come back with facts.

## When a hook notice arrives mid-edit

A PreToolUse notice means a detector matched what you were writing, or the file is governed by a decision.

- If it is a real conflict: stop, undo or hold the offending change if it already landed, and raise it as above. Do not carry on and mention it at the end.
- If the detector is wrong (the pattern matched something unrelated): tell the developer briefly and, with their agreement, `intentguard resolve <CONF> --as false-positive --note "<why>"` so it is not raised again.
- A "governed by recorded decisions" reminder with no conflict needs no reply — just make sure the edit respects it.

## Rejected ideas

If the plan — yours or the developer's — revives something on record as rejected, mention the earlier rejection and its reason before proceeding. Circumstances change; the developer may well choose it this time. They should choose it knowingly.

## Never

- Never weaken, reinterpret or work around a recorded decision to make a task fit.
- Never grant an exception, dismiss a conflict, or change a decision without the developer's explicit answer.
- Never treat a *proposed* decision as binding — it has not been confirmed. Mention it; do not enforce it.
