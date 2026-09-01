# Plan: Grant-vault hardening (honest trust model + KMS + surfaces)

Canonical interactive plan: Cursor CreatePlan **Security hardening**. Topology: [.loadout/tasks/security-hardening/TASK.md](../../.loadout/tasks/security-hardening/TASK.md). Research twin: [docs/plans/2026-08-31-security-hardening.md](../../docs/plans/2026-08-31-security-hardening.md).

This file is the workspace twin of the research plan. The full specification (requirements, ACs, decisions D-01–D-11, tasks T-01–T-06, rollout, review changelog) lives in the research twin. Do not implement from a stale subset; read that file.

## Review status (2026-08-31)

Review-plan applied in place. P0/P1 incorporated:

- Expand/contract KEK boot (`VAULT_KEK_REQUIRE_KMS`); first plane deploy still boots on raw `VAULT_KEK`.
- `rotateKek(old, new)` try-new-then-old; `listOrgs` + `updateOrgWrappedDek` on both stores.
- Rate limit + token rotate on `VaultStore` + `HOSTED_SCHEMA_SQLITE` (no `migrations/003_rate_limit.sql`).
- No MCP session store; bearer-only auth; AC-13 locks that.
- `POST /runtime/resolve` (not GET).
- Collect: operator `GET /api/need-items/:id`; unauth collect is shell.
- CORS: disallowed Origin → 403 + no ACAO.
- CSP Clerk extra hosts; laptop `kek-wrap`; `npm audit --omit=dev --audit-level=high`.

## Task topology

**pipeline**, shared-trunk. Units U-01–U-06 in TASK.md. Overlap: `kernel.ts`, store files, `cli.ts`.
