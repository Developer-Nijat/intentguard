---
description: List conflicts between the code and recorded decisions, and resolve them
argument-hint: "[pending|resolved|dismissed|all]"
---

# Decision conflicts

The IntentGuard CLI is `node "${CLAUDE_PLUGIN_ROOT}/bin/intentguard.js"` — written below as `intentguard`.

Run `intentguard conflicts` (add `--status $ARGUMENTS` when the developer asked for `resolved`, `dismissed` or `all`).

For each pending conflict, show: its ID, the decision it runs against (ID and title), the rule, what was detected and where, and how many times it has been seen. Use `intentguard why <CONF>` when the developer wants the full decision behind one.

Then ask the developer how to settle each one. The choice is theirs:

| Choice | Command |
| --- | --- |
| Keep the decision; the code will be changed to comply | `intentguard resolve <CONF> --as kept --note "<what will change>"` |
| The decision is out of date and will be changed | `intentguard resolve <CONF> --as updated`, then update or supersede the decision (`/intentguard:review`) |
| Allow it here as a recorded exception | `intentguard resolve <CONF> --as exception --note "<why this case is allowed>"` (optionally `--expires 2026-12-31`, `--scope "<glob>"`) |
| The detector was wrong | `intentguard resolve <CONF> --as false-positive --note "<why>"` — it will never be raised again |

If the developer chooses to keep the decision and wants the code fixed now, make that change. If nothing is pending, say so in one line.
