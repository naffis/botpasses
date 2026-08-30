---
name: improving-test-coverage
description: Raise test coverage meaningfully — measure, find untested critical paths and branches, add real behavior tests, and set a diff-coverage gate without gaming the metric. Use when coverage is low, before a release, or setting up coverage in CI.
---

# Improving test coverage

## Trigger

Coverage is low or unmeasured, you're hardening a critical module, or you're wiring coverage into CI.

## Workflow

1. **Measure first.** Run the suite with coverage and read the report by **branch**, not just line. Note overall, and per-file for the risky modules.
2. **Rank gaps by risk, not by size.** Target uncovered **critical paths**, complex logic, and **error/branch paths** (the `catch`, the `else`, the null case). Ignore trivial getters, generated code, and third-party.
3. **Add real behavior tests** for each gap (use `writing-tests`): exercise the uncovered branch through the public surface with meaningful assertions. Don't write tests that merely execute lines.
4. **Don't game it.** No assertion-free tests, no `expect(true)`, no excluding files to lift the number. If a green gate doesn't mean real tests, it's worse than no gate.
5. **Verify assertion quality on critical code.** Coverage proves lines ran, not that bugs are caught — for high-stakes logic, run mutation testing (e.g. Stryker/mutmut/PIT) and kill surviving mutants.
6. **Lock in the gain in CI.** Add a **diff/patch coverage** gate so new code stays covered, and a global floor that **ratchets up, never down** (a team-chosen floor, not 100%). Patch coverage is the highest-leverage gate.
7. **Report** the before/after and the remaining accepted gaps (with a one-line reason each).

## Guardrails

- Coverage is a guide, not a goal (`test-coverage`). Stop chasing the last few percent if it forces bad tests.
- A flaky new test is a regression — keep additions deterministic (`triaging-flaky-tests`).

## Pairs with

- rules: `test-coverage`, `testing-conventions`, `regression-test`
- skills: `writing-tests`, `triaging-flaky-tests`
