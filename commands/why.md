---
description: Show a recorded decision and the reason behind it (by ID, file path, or topic)
argument-hint: "<DEC-0001 | path/to/file | topic>"
---

# Why was this decided?

The IntentGuard CLI is `node "${CLAUDE_PLUGIN_ROOT}/bin/intentguard.js"` — written below as `intentguard`.

Run:

```
intentguard why $ARGUMENTS
```

- An ID (`DEC-0012`, `CON-0003`, `CONF-0001`, `ALT-0002`) shows that record.
- A file path shows every decision governing that file.
- Anything else is a keyword search over decisions and rejected ideas.

If `$ARGUMENTS` is empty, run `intentguard list` and ask which decision the developer means.

Present what the store says: the decision, its reason, scope, constraints, evidence (and whether the evidence is still verified, changed or missing), rejected alternatives, exceptions, and open conflicts. Quote the recorded reason; do not paraphrase it into something stronger, and do not fill gaps with your own guesses. If nothing matches, say that no decision is recorded on this — that is useful information too — and offer `/intentguard:remember` if the developer wants to record one.
