# Task: email-at-rest

## Outcome

Each hosted plane has `VAULT_KEK_REQUIRE_KMS=1` and no raw `VAULT_KEK` before production deploy. After deploy, a Neon dump contains no inbox strings and no usable OAuth refresh/auth/device/session/interaction tokens; operators still sign in, invite, and see emails; MCP OAuth and client revoke still work. Item and org keys are not derived from email. Grant ids stay plaintext (D-07).

## Spec pointer

- Plan: `docs/plans/2026-09-09-email-at-rest.md`
- CreatePlan: Email at rest + KMS

## Topology

- Choice: single-loop
- Escalation test 1 (disjoint files / no data dep): FAIL — T-02 stores, T-03 identity/kernel, T-04 tests, and T-06 adapter all share `schema.ts`, both stores, `identity-keys.ts`, `email-directory.ts`, and `oidc-adapter.ts`.
- Escalation test 2 (independent verifiers): FAIL — store parity, identity harness, and oauth-flow need the same migration and directories.
- Rationale: Default single-loop. Graph is illegal on overlapping allowlists. Pipeline adds handoff cost without a disjoint verifier.

## Shared contract

- Path: N/A for single-loop
- Editor: N/A

## Full-suite verifier

`npm run lint && npm test && npm run typecheck`

## Units

Single-loop: no parallel units.

## Merge order

1. Entire change on shared trunk `dev`

## Isolation mode

- shared-trunk
- Reason: `shared-working-tree` is installed; user did not ask for a worktree.

## Notes / failures

- T-01 is operator Fly/AWS verification and a **deploy** gate. Do not write secret values into this file. Code tasks proceed without `flyctl`.
- T-06 is the OAuth-token dump control. Locked: D-07 (no HMAC of Grant.id), D-08 (indexes from plaintext), D-10 (required `oidcDirectory`), D-11 (wrap `{ id, body }`).
- D-12 (T-03): hash magic-link `code_hash`; do not persist the URL token. 8-digit codes already hash.
- Migration file is `015_email_and_oidc_at_rest.sql` (D-09). If another `015_*.sql` is already in the tree, stop and ask.
- Escalation tests still fail after T-06. Stay single-loop.
