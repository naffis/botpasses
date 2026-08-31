# Task: key-discovery-and-store-prompt

## Outcome

Hosted model clients can `find_items` by exact name and/or exact API hostname, get up to 5 public candidates, `host_mismatch`, or a path-only Botpasses `collect_url` when none exist. Operator signs in and fulfills; inject is `http.request` without the secret appearing in MCP, collect HTML, inbox JSON, or a mocked agent transcript. `collect_url` has no HMAC query. Local MCP miss tells the operator to `vault store` and does not mint a collect URL.

## Spec pointer

- Plan: `docs/plans/2026-08-30-key-discovery-and-store-prompt.md` (reviewed 2026-08-30)
- Workspace twin: `.cursor/plans/2026-08-30-key-discovery-and-store-prompt.md`

## Topology

- Choice: single-loop
- Escalation test 1 (disjoint files / no data dep): FAIL — kernel, store (`persistFulfill`, `need_items`, `deleteOrg`), mcp, http, and collect HTML share `NeedItemRecord`.
- Escalation test 2 (independent verifiers): FAIL — MCP tests need kernel+store; HTML tests need http.
- Rationale: Graph is illegal. Pipeline would serialize the same overlapping files.

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
- Reason: `shared-working-tree` is installed. User did not ask for a branch or worktree.

## Notes / failures

- Do not implement until the user clicks Build or explicitly asks to implement.
- Do not stage/commit unless the user asks.
- CreatePlan / Build UI requires Cursor Plan mode.
- Review retracted HMAC-on-collect. Fulfill is `requireOperator` + `persistFulfill` on one pg client. Grant `mintApprovalToken` JSON stays `{ grantId, exp }`.
- NeedItemError.payload must survive MCP catch and HTTP sendError. `find_items` need_item/host_mismatch uses mcpPayloadResult (not fail(message)).
- persistFulfill UPDATE WHERE status=pending. insertPendingNeed on unique conflict. Same OrgRateLimiter instance; requestGrant miss alreadyLimited.
