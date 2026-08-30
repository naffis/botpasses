---
name: test-driven
description: >
  Strict red→green→refactor TDD loop for one Given/When/Then slice: write a
  failing test, paste RED output, then minimal production code, then refactor
  under the net. Forbids implementing before a biting failure. Use when the
  user says "TDD", "test-driven", "red green refactor", "write the test first",
  "test-first", "/tdd", or wants implementation driven by a failing test.
  Anti-triggers: add tests after the fact → writing-tests; raise coverage
  metrics → improving-test-coverage; lone bug regression → regression-test
  (still red-first). Prefer over optional TDD in writing-tests for the hard loop.
---

# Test-driven development

Modern agents ship green code then invent tests that never fail. This skill
**forbids production code before a failing test** for the current behavior
slice. Verification is the product.

## Trigger

User wants TDD / test-first for a feature slice, bug, or module change.

## Immediate action

1. Name one Given/When/Then slice (step 0) before writing code.
2. Do **not** edit production code until RED output is pasted.
3. Do not commit/push/PR unless the user explicitly asks.

## Workflow

### 0. Name the slice

One behavior, binary acceptance:

> Given … When … Then …

If the slice is bigger than one test can express, split — still one red test
at a time.

### 1. RED — write a failing test

1. Add the test in the owning package (next to the unit or in the established
   test layout).
2. Use real objects; mock only true boundaries (`writing-tests` /
   `testing-conventions`).
3. **Run the test. Paste output.** It must fail for the **right reason**
   (missing behavior / assertion), not compile noise you then "fix" by
   deleting the assertion.
4. If it passes against current code, the test does not bite — strengthen it
   or pick a different slice.

**Stop condition:** do not edit production code until RED is pasted.

### 2. GREEN — minimal production code

1. Write the smallest change that makes **this** test pass.
2. No extra features, no speculative generalization.
3. Run the same test + relevant neighbors. Paste green output.

### 3. REFACTOR — under the net

1. Clean structure only while tests stay green (`simplifying-code` /
   `refactoring-code` discipline).
2. Re-run tests after each meaningful refactor. Paste final green.

### 4. Next slice or done

- More behaviors → back to step 0.
- Bug fixes: RED must fail on the bug; GREEN is the fix (`regression-test`).
- Done when the named slice's ACs are covered and gates for the package pass.

## Guardrails

- One failing test drives one green step — no batching five reds then a rewrite.
- Prefer the project's focused test runner for one file/name.
- Match existing test patterns in the package.
- Leave edits unstaged unless asked to commit.

## Never do

- Implement first, then "TDD" by adding a passing test
- Skip pasting RED/GREEN command output
- Weaken assertions to get green
- Mock the unit under test

## Pairs with

- skills: `writing-tests`, `improving-test-coverage`, `simplifying-code`,
  `debugging-an-issue`, `triaging-flaky-tests`
- rules: `regression-test`, `testing-conventions`, `test-coverage`, `no-shortcuts`
- commands: `tdd` (`/tdd`) — registry id `tdd-cmd`
- workflows: `ship-a-feature`, `plan-then-build`, `safe-refactor`
