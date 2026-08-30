---
name: making-a-pr-reviewable
description: Make a PR easy to review without changing behavior — tidy history, sharpen the description, and add reviewer guidance. Use before requesting review on a noisy or large PR.
---

# Making a PR reviewable

## Trigger

A PR is functionally done but hard to review: noisy commit history, a thin description, or a large diff.

## Workflow

1. **Tidy history (no behavior change):** squash fixup/"wip" commits into logical units; keep each commit a coherent step. Don't rewrite shared history others built on.
2. **Sharpen the description:** what changed, why, and concrete "Verify that…" steps. Call out migrations, flags, and rollback. Link the ticket.
3. **Guide the reviewer:** note the entry point ("start in `src/x`"), what's mechanical vs substantive, and anything intentionally out of scope.
4. **Reduce noise:** move unrelated formatting/renames into their own commit (or PR) so the substantive diff stands alone.
5. **Self-review the diff** as if you were the reviewer; fix anything confusing before asking for eyes.

## Guardrails

- Tidying must not change behavior — verify tests still pass after a rebase/squash.
- Don't force-push a branch others are working on.

## Pairs with

- rules: `commit-and-pr-conventions`
- skills: `opening-a-pr`, `reviewing-and-shipping`
- workflows: `ship-a-feature`, `plan-then-build`
