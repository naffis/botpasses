---
name: refactoring-code
description: Safely refactor code without changing behavior — split a large file, extract functions, untangle nesting — behind a test net, in small reviewable moves. Use when improving structure of existing code.
---

# Refactoring code

## Trigger

Improving the structure of existing code (split an oversized file, extract a function, flatten nesting, break a cycle) without changing what it does. Often follows `reviewing-code-quality`.

## Workflow

1. **Establish the test net first** (per `refactor-discipline`). If the behavior you're moving isn't covered, add characterization/boundary tests that pin current behavior before you touch anything.
2. **Plan the target shape.** Name the seams: what becomes its own module/function, what the boundaries are. For a large file, group by cohesion (one responsibility per extracted unit).
3. **Move in small, pure steps.** Each step is behavior-preserving: extract, move, rename, re-export. Run the tests (and typecheck) after each step — a green-to-green sequence of obvious moves beats one big reshuffle.
4. **No side quests.** Don't fix bugs or add features mid-refactor; note them and do them in a separate commit with a regression test.
5. **Keep public APIs stable** where possible; if a signature must change, update call sites in the same step and re-run tests.
6. **Commit the refactor on its own** with a clear message, so review sees only structural change.

## Common moves

- File over the size limit → extract cohesive modules; keep a thin re-export if imports are widespread.
- Long function → extract named helpers; replace flag args with separate functions.
- Deep nesting → early returns / guard clauses.
- Big `switch` → lookup table or polymorphic dispatch.

## Guardrails

- If tests don't exist and can't reasonably be added, stop and say so — refactoring without a net is a rewrite in disguise.
- Don't "improve" code you're not changing for a reason; scope the refactor.

## Pairs with

- rules: `refactor-discipline`, `size-limits`, `testing-conventions`
- skills: `reviewing-code-quality`, `writing-a-migration`
- workflows: `safe-refactor`
