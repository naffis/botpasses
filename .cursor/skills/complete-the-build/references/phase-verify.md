# Phase verify checklist — complete-the-build

Run before marking any gap-matrix row `Done`. Tightened for exhaustion.

## Correctness

- [ ] Matches the plan item / AC (not a proximate substitute)
- [ ] Happy path exercised (test or explicit manual/command proof)
- [ ] Failure path handled (validation, dependency down, partial failure)
- [ ] Empty / null / boundary inputs handled
- [ ] No silent catch / empty fallback without a structured log or event

## Completeness

- [ ] All ACs for this phase/task satisfied
- [ ] No half-finished files touched for this row
- [ ] No new TODO/FIXME/stub left for this row (unless survivor-logged)
- [ ] No debug leftovers (`console.log`, `.only`, commented-out prod paths)

## Integration

- [ ] Works with already-built phases (handoff data in/out)
- [ ] Imports, config, migrations, env docs updated if required
- [ ] Applicable DoD rows for this change class done in the **same** change
      (tests, changelog, owning doc, public surfaces, …)

## Regression

- [ ] Affected package tests green (paste outcome when claiming Done)
- [ ] New behavior has happy + failure + edge coverage when non-trivial
- [ ] Bug fixes include a regression test that fails on revert

## Marking Done

Update the matrix row with:

1. `Location` — `path:symbol` (or paths)
2. `Verified how` — test name(s) and/or command + exit
3. Status → `Done`

If any checkbox fails, keep status `Partial` / `Missing` and continue the
build loop — do not mark Done on hope.
