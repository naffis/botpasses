# Task: grant-vault-product

## Outcome

Hosted multi-user grant vault on Fly + Neon + Cloudflare: model never sees concealed values; Grok/Claude/ChatGPT/Cursor can request grants and use `http.request`; operators approve via web, Resend, or code; AC-01…AC-11 pass; `npm test && npm run typecheck` green.

## Spec pointer

- Cursor plan: `~/.cursor/plans/grant_vault_product_1a24ec63.plan.md`
- Research: `docs/plans/2026-08-30-grant-vault-product.md`

## Topology

- Choice: pipeline
- Escalation test 1 (disjoint files / no data dep): FAIL — T-01…T-08 share `src/db.ts`, `src/vault.ts`, `src/server.ts`, `src/mcp.ts`
- Escalation test 2 (independent verifiers): FAIL — later stages import T-01 types
- Rationale: overlapping kernel files; sequential stages with full-suite after each

## Shared contract

- N/A — pipeline, no parallel units

## Full-suite verifier

`npm test && npm run typecheck`

## Units

single-loop/pipeline: no parallel units. Stages are T-01…T-10 in the plan.

## Merge order

1. T-01
2. T-02
3. T-03
4. T-04
5. T-05
6. T-06
7. T-07
8. T-08
9. T-09
10. T-10
11. T-11 (Phase 2; optional flag `VAULT_AGENTPASS`)

## Isolation mode

- shared-trunk
- Reason: `shared-working-tree` is installed; user did not ask for worktrees

## Notes / failures

- Do not rewrite persistence to D1 or Durable Object SQL.
- Hosted store is Neon Postgres; do not use Machine-local sqlite in `VAULT_MODE=hosted`.
- Do not use Cloudflare Tunnel as the public product URL.
- Do not set Fly `count = 2` in T-10. MCP Streamable HTTP is in-process until T-10b.
- Do not add `get_secret` for model tokens.
- Connector display name for Claude: `AgentVault` (ASCII only).
- Do not implement AgentPass Authority HTTP in T-01…T-10. T-01 stores `task_id` / `task_description` only. T-11 is Phase 2 behind `VAULT_AGENTPASS`.
