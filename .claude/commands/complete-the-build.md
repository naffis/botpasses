---
description: Exhaust remaining plan phases — gap matrix, build what's left, two clean passes, hand off to review-build.
---

Run the `complete-the-build` skill in full. Inventory every plan phase,
acceptance criterion, and deferral; build Partial / Missing / Punted work to
an empty gap matrix; prove with gates; hand off to `review-build`.

You are building, not reviewing. Publish the gap matrix **before** coding.
Silent deferrals are failures. Prefer a fresh chat for `review-build` after
COMPLETE.

## Process (do not skip)

1. Ground truth — plan + `git status` / `git diff` vs base.
2. Gap inventory — matrix before edits (`references/gap-matrix.md`).
3. Work queue — P0 → missing ACs → Partial/Punted → DoD/tests/docs.
4. Build loop — one unit; phase verify; mark Done with evidence.
5. Completeness re-pass — rebuild matrix; shortcut sweep; DoD; gates (paste output).
6. Converge — two consecutive clean passes (survivors only with named criteria).
7. Completion Report + handoff to `review-build`.

Do not commit/push/PR unless explicitly asked.

Plan path / focus: $ARGUMENTS
