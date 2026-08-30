---
name: reviewing-code-quality
description: Audit code for maintainability — oversized files/functions, deep nesting, duplication, leaky boundaries, dead code, and unclear naming. Use to assess code health or before merging a large change, separate from a correctness review.
---

# Reviewing code quality

## Trigger

Assessing maintainability of a file, module, or diff — distinct from a correctness review (`reviewer` agent) and from slop cleanup (`deslopping`).

## Workflow

Walk the target and flag issues, worst-first. Check:

1. **Size** (per `size-limits`): files over ~400 lines, functions over ~50, giant `switch`/`if` ladders that want a table or polymorphism.
2. **Nesting & control flow:** deep nesting that early returns would flatten; long parameter lists; boolean flag args that hide two functions.
3. **Duplication:** copy-pasted logic that should be one helper; parallel structures that drift.
4. **Boundaries & coupling:** business logic in controllers/handlers/UI; modules reaching across layers; circular deps; leaky abstractions.
5. **Naming & clarity:** vague names (`data`, `handle`, `manager`), names that lie, comments compensating for unclear code.
6. **Dead weight:** unused code/exports, commented-out blocks, speculative abstraction (one-use interfaces, config for values that never vary).
7. **Error handling:** swallowed errors, over-broad catches, fallbacks that mask failures (see `no-shortcuts`).

## Output

A prioritized list: each finding with file:line, why it hurts maintainability, and a concrete fix (often "extract", "flatten", "rename", "delete"). Separate must-fix (actively harmful) from nice-to-have. Don't rewrite working code for taste; flag and recommend.

## Guardrails

- This is an assessment, not a refactor — to act on findings, use `refactoring-code` (behavior-preserving) or file focused fixes.
- Report what affects maintainability; avoid style nits a linter already enforces.

## Pairs with

- rules: `size-limits`, `refactor-discipline`, `no-shortcuts`
- skills: `refactoring-code`, `deslopping`
- agents: `reviewer`
- workflows: `safe-refactor`
