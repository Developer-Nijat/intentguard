---
description: Check the current changes (or a plan) against recorded decisions
argument-hint: "[files... | --staged | --base <ref> | --plan \"what you intend to do\"]"
---

# Check changes against decisions

The IntentGuard CLI is `node "${CLAUDE_PLUGIN_ROOT}/bin/intentguard.js"` — written below as `intentguard`.

## 1. Mechanical check

Run:

```
intentguard check $ARGUMENTS
```

With no arguments it examines the working tree against `HEAD` (plus untracked files). `--staged` checks the index, `--base main` checks the branch diff, explicit file paths check those files in full, and `--plan "<text>"` compares an intended change with recorded decisions before any code exists.

The report gives one of four verdicts:

| Verdict | Meaning |
| --- | --- |
| Compatible | No recorded decision is affected, or every detector is clean. |
| Unknown | A decision governs the changed files but has no mechanical detector. **You** must judge it — step 2. |
| Potential conflict | A detector pattern matched. Intent still needs confirming. |
| Confirmed violation | A protected path was modified. |

## 2. Semantic review

For every decision listed under "cannot be checked mechanically", read the actual change in the listed files (`git diff` or the files themselves) and compare it with the decision's statement, constraints and reason. Classify each as compatible, potential conflict, or confirmed violation — or leave it unknown if you genuinely cannot tell, and say what is missing. Do not round "I am not sure" up to "compatible".

For a large change, delegate this step to the `intentguard:decision-auditor` agent and relay its findings.

## 3. Report

Lead with the overall verdict. For each conflict cite the decision ID, the rule, the recorded reason, the evidence, and the file and line that triggered it. Then put the choice to the developer:

1. Keep the decision — adjust the change.
2. Update the decision — it no longer fits (`/intentguard:review`).
3. Allow an explicit exception.
4. Investigate further.

Apply their choice with `intentguard resolve <CONF> --as kept|updated|exception|false-positive --note "<why>"`. A conflict you found semantically has no `CONF` record; describe it and act on the developer's answer directly.

Do not resolve conflicts, grant exceptions or change decisions on your own initiative. IntentGuard exists so that changing course is a deliberate act by the developer.
