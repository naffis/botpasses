# Session-surface verify report

Copy this shape. A `WORKS` row without quoted evidence is FAIL.
`CLEAN` on an empty RECEIPT is FAIL unless reconstruction shows no
session work (see `session-scope.md`).

```markdown
# Session surfaces — <date>

## Ask (verbatim)

<every user message that added or changed scope>

Implied surfaces / functions (including file-less):

1. …

## Reconstruction

- Conversation-edited files:
- Dirty / staged / untracked:
- `--since` used: none | <ref>
- Shared-tree path args: none | …

## Inventory RECEIPT

\`\`\`
<paste session-inventory.sh RECEIPT through END>
\`\`\`

Session paths only: yes / no (if no: why)
Surfaces after collapse: N
Ask-implied rows added: N
Composed-path rows: N (required if two layers join)

## Contract

- End state:
- Evidence:
- Constraints:
- Budget: 3 cycles/finding · used:

## Matrix

| #   | Surface | Claim                | Layer                            | Verdict                  | Evidence (command / status / path) |
| --- | ------- | -------------------- | -------------------------------- | ------------------------ | ---------------------------------- |
| 1   |         | When I … I observe … | ui/api/cli/mcp/job/realtime/flag | WORKS/BROKEN/BLOCKED/N/A |                                    |

## Fixes

| ID  | Symptom | Root (one sentence)                           | Layer changed | Regression test       | Re-exercise          |
| --- | ------- | --------------------------------------------- | ------------- | --------------------- | -------------------- |
| F1  |         | The bug exists because **_, which causes _**. | file:symbol   | path · fail-on-revert | same claim # · WORKS |

Skipped `root-cause-fix` for: none | <id + why>

## Gates

<quoted closers from typecheck / affected tests — not a bare ✅>

## Checker

- `flight-checker`: PASS / FAIL / skipped (why)
- Reconcile: none | findings + disposition

## Residual

BLOCKED rows, env gaps, cost-skipped paid runs, correctness-vs-scope.

## Verdict

CLEAN — every row WORKS or N/A-with-reason; no unanswered ask row;
fixes class-killed; checker PASS; RECEIPT empty only if reconstruction
proves no session work
NEEDS WORK — listed BROKEN/BLOCKED, or missing ask/composed rows
```
