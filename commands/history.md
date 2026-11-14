---
description: Show the history of recorded decisions — what changed, when, and who did it
argument-hint: "[DEC-0001] [--limit N]"
---

# Decision history

The IntentGuard CLI is `node "${CLAUDE_PLUGIN_ROOT}/bin/intentguard.js"` — written below as `intentguard`.

Run:

```
intentguard history $ARGUMENTS
```

With a decision ID it shows that decision's trail; without one, the most recent events across the project (`--limit N` for more; default 50).

Present it as a short timeline, newest first: date, what happened (recorded, confirmed, updated, superseded, constraint added, conflict detected or resolved, exception granted…), and by whom — the developer, Claude, or a hook. For updates, mention what changed (`--json` includes the before/after values if the developer asks for detail). When a decision was superseded, name its successor.

Report only what the trail contains.
