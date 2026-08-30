---
name: writing-tests
description: Write effective tests for new or changed code — cover behavior, edge cases, and error paths at the right level, with real objects and boundary-only doubles. Use when adding a feature, before/while implementing (TDD), or filling a test gap.
---

# Writing tests

## Trigger

Adding or changing behavior that should be tested, filling a gap, or working test-first.

## Workflow

1. **List the behaviors to test**, not the lines: the happy path, the meaningful edge cases (empty, boundary, large, concurrent), and the **error paths** (invalid input, upstream failure, timeout). Each becomes a test.
2. **Pick the level** (testing trophy / pyramid): push logic to fast unit tests; use integration tests for real wiring across a boundary; reserve e2e for a few critical user paths. Don't write an e2e for what a unit test can prove.
3. **One behavior per test**, named for the behavior. Structure **Arrange-Act-Assert**. Assert on meaningful outcomes, not snapshots of everything.
4. **Use real objects; mock only true boundaries** (network, clock, filesystem, third-party SDKs). Don't mock the unit under test or internal collaborators you could use for real (see `testing-conventions`).
5. **Make it deterministic:** inject the clock, seed randomness, await async, isolate shared state — so it can't flake (`triaging-flaky-tests`).
6. **Working test-first (optional but encouraged):** write a failing test (red) → minimal code to pass (green) → refactor under the test net. For bug fixes this is required (`regression-test`). When the user wants the hard loop (no production code before pasted RED), use `test-driven` (`/tdd`).
7. **Confirm the assertions bite:** a test that passes against broken code is worthless — verify it fails when the behavior is wrong.

## Guardrails

- Cover behavior and branches, not a coverage number — no assertion-free or `expect(true)` tests (`test-coverage`).
- Don't over-test the trivial (getters, generated code); spend effort on critical/complex logic.

## Pairs with

- rules: `testing-conventions`, `test-coverage`, `regression-test`
- skills: `test-driven`, `improving-test-coverage`, `triaging-flaky-tests`,
  `debugging-an-issue`
- workflows: `ship-a-feature`, `plan-then-build`, `debug-production`, `security-pass`,
  `safe-refactor`, `ship-a-migration`, `dependency-bump`, `clear-the-queue`
