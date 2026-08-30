# Multi-plane deploy

A deploy order for an app split across several planes (database, background runner, edge
worker/API, static site, render/compute). Adapt the plane names to your stack; the
ordering principle is what matters.

## Principle

Deploy in dependency order so each plane is ready before the one that depends on it, and
so a schema is always compatible with the code reading it (expand/contract).

## Order

1. **Database / schema** — apply migrations first, expand-only (additive). Never deploy code that reads a column the DB doesn't have yet.
2. **Background runner / workflows** — deploy workers/queues that the API will hand work to.
3. **Edge worker / API** — deploy the request layer once its dependencies exist.
4. **Static site / client** — deploy last so users only see new UI once the API supports it.
5. **Render/compute** (if separate) — deploy on its own cadence; keep it backward-compatible.

## Guardrails

- One environment at a time: ship to staging, verify, then promote to production.
- Health-check each plane after its step before moving on (`curl https://<host>/health`).
- Keep the previous version deployable for fast rollback; contract (drop old columns) only after the new code is stable.
- Never bake environment-specific config (URLs, keys) into a build meant for another environment.

## Rollback

Reverse order where it matters; never roll back a DB past a destructive contract step.
Prefer rolling forward with a fix for schema once contracted. For an active outage, use the
`hotfix-and-rollback` runbook to choose rollback vs flag vs forward hotfix before following
this order mechanically. Schema work itself is sequenced by the `ship-a-migration` workflow.
