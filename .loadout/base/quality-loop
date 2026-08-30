---
description: Run one cycle of the product quality loop - dogfood the product, find issues, fix them at the root, and leave the rubric sharper.
---

Run the `run-quality-loop` workflow: $ARGUMENTS

1. Pick the entry point from the goal: behavior/output quality →
   `exercising-the-product`; UI/UX quality → `reviewing-ui`; matching a specific
   visual target → `recreating-a-design`. If unclear, ask one line.
2. Read the skill and its references and follow them exactly. Read the existing
   state file / decision log FIRST and resume — never restart a loop that has state.
3. Preflight before looping: one healthy dev stack, baseline gates green, evidence
   harness ready. Write the acceptance contract (end state / evidence / constraints /
   budget) into the state file before touching anything.
4. Run the cycle. Evidence discipline throughout: mechanical checks before vision,
   re-fetch real output after every mutation, never bypass the UI to make a check pass.
5. Fix each confirmed defect via `root-cause-fix` with a fail-on-revert regression
   test, then re-run the operation that exposed it.
6. Close: append new failure modes to the rubric/matrix, dispatch the `reviewer`
   subagent on the diff + contract, leave all edits unstaged, and report what ran,
   what was found, what was fixed, and what was deliberately left.

If $ARGUMENTS names a focus area (e.g. "editing", "mobile", "onboarding"), run the
full preflight but weight the cycle toward that area.
