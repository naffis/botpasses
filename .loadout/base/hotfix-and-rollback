# Hotfix and rollback

When production is broken **now**, choose the smallest reversible action that restores
service, then fix the class properly. This runbook is the decision checklist; the actual
investigation and class fix still go through `debug-production` / `root-cause-fix`. Do not
invent a parallel process under pressure.

## Decide: rollback vs forward-fix vs flag

Pick **one** primary action. Write it down before touching prod.

| Option | Choose when | Avoid when |
|---|---|---|
| **Rollback / redeploy previous** | Last deploy is clearly implicated; previous artifact is known-good; schema is still compatible (no destructive contract applied). | A migration has already contracted/dropped data you need; the bug predates the last deploy. |
| **Feature flag / config kill-switch** | The bad path is flag-gated or can be disabled without a full revert; blast radius is one feature. | The flag doesn't actually isolate the failing path; "config only" still requires a code deploy you don't have. |
| **Forward hotfix** | Rollback is unsafe (schema, data, irreversible external side effects) or the fix is tiny and proven; you can verify quickly. | The cause is still a guess; the change needs a migration; you're tempted to "also clean up." |

Default bias under uncertainty: **restore service with rollback or flag**, then class-fix on
a normal branch. Forward hotfixes are for when rollback is worse than a surgical patch.

## Blast radius (fill before acting)

- [ ] Symptom + first-seen time + environment
- [ ] Correlation ids / error-tracker link
- [ ] Who/what is affected (users, tenants, jobs, money, data integrity)
- [ ] What changed recently (deploys, flags, migrations, deps, traffic)
- [ ] Can we still roll back the DB? (If a **contract** migration ran, assume **no** —
      roll forward; see `multi-plane-deploy` + `db-migration-safety`.)
- [ ] Secrets/PII exposure risk? If yes, involve the owner before pasting logs
      (`no-secrets-in-code`).

## Execution order

1. **Stabilize communication** — who is on point, where status is posted, what "resolved"
   means. Don't debug in silence on a customer-facing outage.
2. **Evidence first** — follow `debug-production` steps 1–2 (`debugging-with-observability`).
   Quote the signal. No speculative restarts as a substitute for a cause.
3. **Take the chosen primary action**
   - **Rollback:** redeploy the last known-good artifact per `multi-plane-deploy` reverse
     rules where they matter; never roll a DB past a destructive contract.
   - **Flag:** flip the kill-switch; verify the failing path is actually dark.
   - **Hotfix:** smallest possible diff; no refactors, no dependency bumps, no migrations
     in the same change (`assessing-release-readiness`: don't bundle risky migrations with
     urgent hotfixes). Ship through the normal gate as far as time allows; skip only what
     the user explicitly authorizes skipping — and record the skip.
4. **Verify recovery** — same correlation-id path / metrics / user journey that proved the
   outage. Health-check each plane you touched. Watch for a second failure mode after
   rollback (partial deploys).
5. **Lock the class fix** — once service is stable, run `root-cause-fix` (or finish
   `debug-production`) on a normal branch: prove cause, fix the class, fail-on-revert
   regression test. A hotfix that only unblocks without a follow-up is incomplete.
6. **Post-incident ratchet** — short note: trigger, detection gap, action taken, follow-ups.
   Turn any process/agent miss into a permanent guard via `hardening-the-harness` (alert,
   test, rule, hook). Update runbooks if the deploy/rollback order was wrong.

## Hard no's

- No destructive DB contract "to make the hotfix work."
- No disabling monitors, tests, or security checks to get a deploy green.
- No prod data surgery without an explicit owner decision and a restore plan.
- No silent "retry the job" as the only fix when the job will fail the same way.
- No shipping the class fix and the emergency revert as one tangled PR if that obscures review.

## Hand-off

When the immediate action is done, the state for the next session should include: action
taken, evidence of recovery, remaining root-cause work, and any temporary skips to undo.
Point that session at `debug-production` or `root-cause-fix`, not at another ad-hoc hotfix.
