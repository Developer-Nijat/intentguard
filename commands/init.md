---
description: Start using IntentGuard in this project (creates the local decision store)
argument-hint: "[observe|warn|enforce]"
---

# Initialise IntentGuard

The IntentGuard CLI is `node "${CLAUDE_PLUGIN_ROOT}/bin/intentguard.js"` — written below as `intentguard`.

1. Run `intentguard init` from the project root. If the developer passed a mode in `$ARGUMENTS` (`observe`, `warn` or `enforce`), add `--enforcement <mode>`. The default is `warn`.
2. Report in two or three lines: where the data lives (`.intentguard/`, local only, database git-ignored) and the enforcement mode.
3. Offer — do not start without a yes — to look for decisions the project has already written down: `CLAUDE.md`, `AGENTS.md`, `docs/adr/`, `docs/architecture*`, `ARCHITECTURE.md`, `CONTRIBUTING.md`.
4. If the developer agrees, read those files and list the candidate decisions you found (at most 8, the most load-bearing first). For each give: a title, the decision, the reason **as the document states it**, the scope, and the file/section it came from. If a document gives no reason, say so rather than inventing one.
5. Ask which candidates to record. Record only the approved ones, each with `"source": "document"`, the file as evidence, and `--confirmed`. Follow the `/intentguard:remember` procedure for the JSON shape.

Never record a decision the developer has not explicitly approved.
