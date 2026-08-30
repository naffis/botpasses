# Automation / loop starter (template)

A starting point for an autonomous loop (scheduled task, eval campaign, fix loop). Pass the
`loop-preflight` runbook BEFORE you schedule anything, and follow the execution-order law:
make a manual run reliable → document it as a skill → wrap it in a loop → only then schedule.

## 1. Definition

- **Goal (stop condition):** <what must be objectively true to be "done">
- **Gate (verifier):** <the command/metric that can reject bad output — tests, lint, build, eval>
- **State file:** <path, e.g. `.loadout/state/<loop>.md`> (see `templates/STATE.md`)
- **Hard caps:** max iterations <N>, max tokens/budget <X>, timeout <T>
- **Human gate:** approval required before <merge / production / irreversible action>

## 2. The loop (one iteration)

1. Read the base spec + state file (re-read every iteration so constraints don't drift).
2. Find the next unit of work.
3. Do the work.
4. **Verify with the gate.** Maker ≠ checker: a separate agent/model checks the result.
5. Record the outcome + any lessons in the state file.
6. If the stop condition holds or a cap is hit → stop. Else → next iteration.

## 3. Scheduling (only after the manual loop is reliable)

```jsonc
// Cursor: .cursor/automations or Claude Code: scheduled task / cron / GitHub Actions
// cadence: "<e.g. 0 13 * * 1>"   // keep it boring and observable
// findings → a triage inbox / PR, never silent auto-merge
```

## 4. Guardrails (the security tax)

- Merge gate includes SAST + dependency + secret scanning.
- No verbose logging in production; sanitize logs of secrets/PII.
- Audit any external skills before use; re-audit the loop's token/permission scopes regularly.
