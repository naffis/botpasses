---
name: debugging-an-issue
description: >
  Evidence-first root-cause debugging loop for everyday bugs. Use for a failing
  test, runtime error, or unexpected behavior that isn't a one-line obvious fix.
  Anti-triggers: user said "yes / do it correctly" after a shallow proposal →
  do-it-right first; proven class fix → root-cause-fix; production issue with no
  local repro → debugging-with-observability.
---

# Debugging an issue

## Trigger

A bug, failing test, or behavior that doesn't match expectation, where the cause isn't
obvious. This is the fast everyday loop; run `do-it-right` first when the user approved a
shallow proposal or said "do it correctly"; escalate to `root-cause-fix` when you need a
proven, generalized class fix, or to `debugging-with-observability` when the bug is in
production/staging with no local repro.

## Workflow

1. **Read the actual error first — the whole thing.** Don't skim. 80% of "weird" bugs are
   explained literally in the message. For a test: scroll past the summary to the actual
   assertion diff. For a type error: read the _full_ error — the first line is a symptom, the
   real conflict is often several lines down. For a runtime stack: start from the frame in
   _your_ code, not the dependency.
2. **State expected vs actual in one sentence each.** If you can't, you don't understand the
   bug yet — go back to step 1. This sentence becomes your regression test's name.
3. **Gather evidence** (per `observability-first`): logs, traces, the failing test output.
   Correlate with a request/run id. Quote the signal.
4. **Minimal reproduction.** Shrink to the smallest case that still fails. The failing test IS
   the repro — run just that case. If you can't repro in ~30 seconds, write a failing test that
   does; the repro is the cheapest leverage for the rest of the loop.
5. **At least two hypotheses; falsify, don't confirm.** List >=2 plausible causes ranked by
   likelihood. Add one targeted log/assert and run the repro to _disprove_ your top hypothesis
   — don't change behavior yet. If the evidence supports it, proceed; if not, the next
   hypothesis is now top. If none survive, re-read the error (step 1) — you missed something.
6. **Smallest fix** that addresses the root cause, not the symptom. Resist "also clean up while
   I'm here" — that's a separate change.
7. **Regression test** that fails before the fix and passes after (`regression-test`). Verify
   it actually fails when you revert the fix — a regression test that can't fail is worse than
   none.

See `references/symptom-decision-tree.md` for a per-symptom "first thing to try" table.

## Symptom shortcuts

- Type error → read the full type, narrow from `unknown`, don't cast to silence it.
- Flaky/intermittent → see `triaging-flaky-tests`.
- 4xx/5xx from an API → decode the error body before changing code.

## Guardrails

- A cause isn't proven until evidence points at it. No "should be fixed now" without a check.
- **Stop and ask after two failed fixes** (or before touching prod data, rotating a secret, or
  disabling a gate). Oscillating fixes mean the cause isn't understood — escalate to
  `root-cause-fix` rather than guessing a third time.

## Pairs with

- rules: `observability-first`, `regression-test`, `no-shortcuts`
- skills: `root-cause-fix`, `do-it-right`, `triaging-flaky-tests`, `fixing-ci`,
  `debugging-with-observability`
- agents: `explorer`
- workflows: `fix-ci-until-green`, `debug-production`
