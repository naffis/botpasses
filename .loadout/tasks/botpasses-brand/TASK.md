# Task: botpasses-brand

## Outcome

Product identity is Botpasses on `https://botpasses.com` and `https://staging.botpasses.com`: UI, MCP, CLI/npm, Fly toml names, docs, and a sequenced infra cutover. `VAULT_*` env names unchanged. `npm test && npm run typecheck` green.

## Spec pointer

- Plan: [docs/plans/2026-08-30-botpasses-brand.md](../../../docs/plans/2026-08-30-botpasses-brand.md)
- CreatePlan: `~/.cursor/plans/botpasses_brand_domain_0b5dd3a1.plan.md`

## Topology

- Choice: single-loop
- Escalation test 1 (disjoint files / no data dep): FAIL — brand module, pages, MCP, package.json, README, fly tomls share one identity change
- Escalation test 2 (independent verifiers): FAIL — full `npm test` is the only honest verifier
- Rationale: overlapping files and one suite gate; graph would breach allowlists

## Shared contract

- Path: N/A for single-loop
- Editor: N/A

## Full-suite verifier

`npm test && npm run typecheck`

## Units

single-loop: no units

## Merge order

N/A

## Isolation mode

- shared-trunk
- Reason: `shared-working-tree` is installed; stay on `dev`. Do not touch files outside the plan allowlist (unrelated loadout/WIP stays in the tree).

## Notes / failures

- Create Fly apps and copy secrets before pushing renamed `fly.*.toml` to `origin/dev`.
- `hostedBootError` must require `VAULT_EMAIL_FROM` only when `RESEND_API_KEY` is set, so existing boot tests without Resend still pass.
