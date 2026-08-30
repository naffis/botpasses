---
name: run-autonomous-loop
uses:
  rules: [no-shortcuts, regression-test, size-limits, definition-of-done]
  skills:
    [
      running-a-dev-cycle,
      agentic-loop,
      planning-a-change,
      create-plan,
      review-plan,
      review-build,
      root-cause-fix,
      verifying-session-surfaces,
      reviewing-and-shipping,
    ]
  agents: [reviewer]
  commands:
    [plan, review-plan-cmd, review-build-cmd, verifying-session-surfaces-cmd]
gate: "<project typecheck + test + lint command>"
stop_condition: "acceptance contract met, review-build PASS, reviewer verdict SAFE, gate green — or budget ceiling hit and escalated"
state: ".loadout/state/run-autonomous-loop.md"
---

# Run an autonomous loop

The unattended, verified, until-contract-met recipe. Unlike `ship-a-feature` (attended, one
bounded feature with a human at each gate), this runs a task as a self-checking loop with an
explicit stop contract, a maker-checker gate, and a durable state file so a fresh context
resumes. Only run this when the work passes the `loop-preflight` 4-condition test.

1. **Frame** — write the acceptance contract (end state / evidence / constraints / budget) per
   `agentic-loop`. Classify the task with `running-a-dev-cycle` and route it to the right phases.
2. **Plan** — `planning-a-change` for anything non-trivial; escalate to `create-plan` /
   `review-plan` (`/plan` → `/review-plan`) when trade-offs are real. The plan is the
   spec the checker verifies against.
3. **Loop each unit** — `agentic-loop`: perceive → act (smallest safe change) → observe (run the
   gate) → verify against the contract → record in the state file → next unit. Respect the budget.
4. **Fix defects at the root** — `root-cause-fix` for any real defect: prove the cause, fix the
   class, lock it with a regression test that fails-before/passes-after.
   4b. **Session surfaces** — if the loop shipped a user-visible surface, run
   `verifying-session-surfaces` (`/verify-surfaces`) before review-build. Live
   evidence, then step 4 on anything BROKEN.
5. **Review the build** — `review-build` (`/review-build`) before declaring the contract met:
   ground-truth diff, requirement/plan trace, shortcut sweep, pasted gate output.
6. **Maker ≠ checker** — before calling the stop condition met, dispatch the `reviewer` agent on
   the diff + the contract. Reconcile real findings; a `DO NOT MERGE`/`MERGE AFTER FIXES` verdict
   loops back to step 3.
7. **Ship the work** — `reviewing-and-shipping` once the verdict is SAFE and the `gate` is green.
   Edits stay unstaged; do not commit/push/PR unless the user asked (`commit-and-pr-conventions`).

Stop and escalate if the budget ceiling is hit while still red, verification can't be defined,
or the fix needs a decision the user owns. Never widen a tolerance or delete an assertion to
force the stop condition. Guard against the self-declared-done trap: the reviewer verdict + the
gate — not the loop's own judgment — decide "done" (see `docs/agentic-patterns.md`).
