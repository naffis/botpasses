---
name: ship-a-migration
uses:
  rules: [db-migration-safety, testing-conventions, no-shortcuts, documentation-updates, definition-of-done]
  skills: [writing-a-migration, writing-tests, assessing-release-readiness, updating-docs, reviewing-and-shipping]
  agents: [reviewer]
gate: "migration up + down verified on a realistic dataset; project typecheck + test + lint green"
stop_condition: "correct expand/contract phase implemented and tested, rollback plan written, readiness GO or GO-WITH-CONDITIONS, docs updated — ready to deploy via multi-plane-deploy"
state: ".loadout/state/ship-a-migration.md"
---

# Ship a migration

Safe schema/data change via expand → migrate → contract, never a destructive one-shot.
Composes `writing-a-migration` with readiness and deploy-order discipline. Use for column/
table changes, backfills, or index work. Do **not** bundle a risky migration with an urgent
hotfix (`hotfix-and-rollback`, `assessing-release-readiness`).

1. **Classify the phase** — decide which deploy this change is:
   - **Expand** — additive only (nullable column / new table / concurrent index). Non-breaking.
   - **Backfill** — data migration, batched for large tables, out-of-band from blocking schema
     DDL when needed.
   - **Dual-read / switch** — application code reads new shape (often a separate
     `ship-a-feature` / `plan-then-build` change).
   - **Contract** — drop old column/constraint only after the new code is stable in production.
   Write the phase and the **rollback story** into the state file before editing anything
   (`db-migration-safety`).
2. **Design the migration** — `writing-a-migration`: no in-place type changes or destructive
   renames in one step; reversible `down` that doesn't lose data; schema and data migrations
   kept separate. Prefer the framework's safe-migration tooling.
3. **Test up and down** — `writing-tests` / manual verification on a realistic dataset: apply
   up, verify shape/data, apply down, verify restoration. For backfills, prove batching and
   idempotency. Never `db:reset` against a remote/shared database.
4. **App compatibility** — confirm running (or soon-deployed) code tolerates this phase:
   expand before code that requires the new column; contract only after dual-read is gone.
   If code and schema must ship together, say so explicitly and treat it as higher risk.
5. **Docs** — `updating-docs`: migration notes, runbook pointers, any operator steps, changelog
   entry (`documentation-updates`).
6. **Readiness** — `assessing-release-readiness` with migration called out on the risk
   surface: rollout order, monitoring, rollback. Verdict must be GO or GO-WITH-CONDITIONS
   (conditions listed). NO-GO means stop — do not "just run it on staging and see."
7. **Review** — dispatch `reviewer` on the migration + app diff vs the phase plan. Check
   especially: irreversibility, lock risk, missing down, expand/contract violations.
8. **Deploy order** — when promoting, follow the `multi-plane-deploy` runbook: database/
   schema first (expand), then runners, then API, then clients. Health-check each plane.
   Contract steps roll forward carefully; never roll a DB past a destructive contract without
   a restore plan.
9. **Ship artifacts** — `reviewing-and-shipping` only if the user asked to commit/PR. Leave
   the state file with phase completed, evidence of up/down, and the next phase still owed
   (e.g. "contract still open").

Never run a destructive contract in the same change as the expand that introduced the new
shape. Never skip the down path. Never disable migration checks to get the gate green.
