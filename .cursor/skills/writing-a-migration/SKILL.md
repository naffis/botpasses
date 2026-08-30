---
name: writing-a-migration
description: Write a safe, reversible database migration using expand/contract. Use when adding, changing, or removing schema or backfilling data.
---

# Writing a migration

## Trigger

A schema change, column change, or data backfill.

## Workflow

1. **Decide the shape change** and split it into expand → migrate → contract phases across separate deploys:
   - **Expand:** add new column/table (nullable / with default), add indexes concurrently. Non-breaking.
   - **Backfill:** migrate data in a separate data migration, batched for large tables.
   - **Ship dual-reading code**, then in a later migration **contract** (drop the old column/constraint).
2. **Never** alter a column type in place or rename destructively in one step — add new, backfill, switch reads, drop old.
3. **Make it reversible:** provide a `down` (or reverse) that doesn't lose data.
4. **Keep schema and data migrations separate.** Use the framework's safe-migration tooling where available.
5. **Test** the up and down paths on a realistic dataset.

## Guardrails

- Never run a destructive migration or `db:reset` against a remote/shared DB.
- Long-running backfills run out-of-band, not inside a blocking schema migration.

## Pairs with

- rules: `db-migration-safety`, `testing-conventions`
- skills: `reviewing-and-shipping`
- workflows: `ship-a-migration`
- runbooks: `multi-plane-deploy`, `hotfix-and-rollback`
