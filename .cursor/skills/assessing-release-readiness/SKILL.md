---
name: assessing-release-readiness
description: Make a go/no-go release assessment for a set of changes. Use before promoting to production or cutting a release.
---

# Assessing release readiness

## Trigger

About to promote changes to production or cut a release.

## Workflow

1. **Scope:** list what's shipping since the last release (merged PRs / commits).
2. **Gates:** CI green, required reviews done, no open must-fix threads.
3. **Risk surface:** migrations present? feature flags? destructive ops? external contract changes? For each, confirm the rollout and rollback plan.
4. **Verification:** the key user paths affected have been exercised (tests or manual), with evidence.
5. **Operational readiness:** monitoring/alerts in place for new surfaces; on-call aware of risky changes.
6. **Verdict:** GO, GO-WITH-CONDITIONS (list them), or NO-GO (list blockers). Be explicit.

## Guardrails

- "Tests pass" is necessary, not sufficient — weigh blast radius and reversibility.
- Don't bundle a risky migration with an urgent hotfix release.

## Pairs with

- rules: `db-migration-safety`, `documentation-updates`
- skills: `reviewing-and-shipping`
- runbooks: `multi-plane-deploy`, `hotfix-and-rollback`
- workflows: `cut-a-release`, `ship-a-migration`
