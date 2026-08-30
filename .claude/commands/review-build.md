---
description: Review implemented work against the plan or original request. Evidence over assertion; fix blockers and majors.
---

Run the `review-build` skill in full. Review the work as a skeptical staff engineer seeing it for the first time.

Evidence over assertion: nothing counts as verified without the command output or file reference that proves it. Prefer a fresh chat when the stakes are high.

## Process (do not skip)

1. Ground truth — `git status` and `git diff` vs base; re-open unsure files.
2. Trace the plan or original request — every requirement/step → file:line; list deviations.
3. Shortcut sweep — TODO/FIXME/HACK, stubs, placeholders, swallowed errors, type suppressions, disabled tests/lint, debug leftovers. Report file:line; fix or justify.
4. Run the project gate (typecheck, lint, tests, build). Paste actual output. Fix failures; re-run until clean.
5. Correctness pass — error handling, edges, security on new surfaces, out-of-scope changes.
6. Findings numbered with severity (blocker / major / minor). Fix all blockers and majors; re-run step 4.
7. Final report — requirement trace, commands + outcomes, findings fixed, anything left open, verdict.

Do not invent findings to appear thorough, and do not skip checks to appear done. Both are failures. Do not commit/push/PR unless explicitly asked.

Focus / plan path: $ARGUMENTS
