---
name: run-quality-loop
uses:
  rules: [ui-evidence, regression-test, no-shortcuts, definition-of-done]
  skills: [agentic-loop, exercising-the-product, reviewing-ui, root-cause-fix, writing-tests]
  agents: [reviewer, explorer]
gate: "<project typecheck + test + lint command>"
stop_condition: "a full scenario + mutation pass (or UI walkthrough) with zero new high-severity findings, reviewer verdict SAFE, gate green — or budget spent and escalated"
state: "_local/quality-loop-STATE.md (behavior) / UI-REVIEW.md (UI)"
---

# Run a quality loop

The dogfooding recipe: use the product as a demanding customer, find what falls short,
fix it at the root, and leave the rubric sharper than you found it. Two entry points
share the same discipline — pick by what "quality" means for this run:

- **Behavior/output quality** → `exercising-the-product` (create → observe → analyze →
  exercise mutations → fix → iterate; ledger in the state file).
- **UI/UX quality** → `reviewing-ui` (context brief → walkthrough → heuristic audit →
  prioritized batches; decision log in `UI-REVIEW.md`).

They feed each other: UI findings surfaced during a behavior run get *logged* to
`UI-REVIEW.md`, not fixed ad hoc; behavior defects surfaced during a UI review get
ledgered, and fixed via `root-cause-fix`.

1. **Preflight** — pass `loop-preflight` (verification automated? budget? tools?). Stack
   healthy, ONE dev instance, baseline gate green, browser evidence harness ready
   (`ui-evidence`). Read the existing state file / decision log first and resume, don't
   restart.
2. **Frame** — write the acceptance contract (end state / evidence / constraints /
   budget) per `agentic-loop` into the state file. List forbidden operations explicitly
   (real publishes, prod writes).
3. **Loop** — run the chosen skill's cycle. Evidence discipline throughout: mechanical
   checks before vision, re-fetch real output after every mutation, never bypass the UI,
   record every finding with its evidence.
4. **Fix at the root** — each confirmed defect goes through `root-cause-fix`: prove the
   cause, fix the class, lock it with a fail-on-revert regression test
   (`regression-test`, `writing-tests`).
5. **Maker ≠ checker** — before calling the stop condition met, dispatch the `reviewer`
   agent on the diff + contract; reconcile real findings.
6. **Compound and close** — append new failure modes to the rubric/matrix so the next
   run checks them automatically; write the closing summary (fixed / open /
   deliberately-left, with evidence). Edits stay unstaged; no commit/push/PR unless
   asked.

Stop and escalate on: budget spent while red, a fix needing a product decision, or an
environment you can't make healthy. A clean pass with zero findings is a success —
never manufacture findings to justify another cycle.
