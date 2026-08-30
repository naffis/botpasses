---
name: deslopping
description: Remove AI-generated slop from a branch diff. Use after generating code, before review, to clean up style without changing behavior.
---

# Deslopping

## Trigger

A branch has AI-written changes that need cleanup before review.

## Workflow

Diff against the base branch and remove slop introduced by the branch:

- Redundant comments that narrate the code ("// increment counter", "// import the module").
- Defensive `try/catch`, null checks, or fallbacks abnormal for trusted internal paths.
- Casts to `any`/`as` used only to bypass the type checker.
- Deeply nested code that early returns would flatten.
- Over-abstraction: one-use helpers, premature interfaces, config for values that never vary.
- Inconsistent naming or style versus the surrounding file.

## Guardrails

- Behavior must stay identical unless you're fixing a clear bug (then add a regression test).
- Match the existing file's conventions; don't impose a new style.

## Pairs with

- rules: `size-limits`, `no-any`, `copy-voice`
- skills: `reviewing-and-shipping`, `simplifying-code` (clarity/YAGNI; distinct job)
- workflows: `safe-refactor`, `ship-a-feature`, `plan-then-build`
