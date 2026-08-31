---
name: Grant vault product
overview: "Multi-user grant vault on Fly (one Machine) + Neon Postgres + Cloudflare WAF: store secrets/logins, approve via policies, inject through a hosted connector. First Build is T-01–T-10. AgentPass Authority is Phase 2."
todos:
  - id: t01-schema
    content: T-01 Schema + VaultStore — sqlite local, Postgres-ready; orgs, items, grants, policies, task fields
    status: completed
  - id: t02-identity
    content: T-02 Clerk Organizations — session orgId required; unauthenticated mutate returns 401
    status: completed
  - id: t03-harden
    content: T-03 Hardening — auth, CAS, no MCP revoke, operator revoke, port 8788, no /health fingerprint
    status: completed
  - id: t04-items
    content: T-04 Item types — secret + login; delete; rotate; password never on MCP
    status: completed
  - id: t05-policies
    content: T-05 policies table — standing short-circuit; owner-only folder_standing
    status: completed
  - id: t06-approval
    content: T-06 Approval — web inbox, Resend magic link, hashed 8-digit code
    status: completed
  - id: t07-access
    content: T-07 MCP OAuth via Clerk CIMD/DCR + REST + stdio — model tokens cannot resolve
    status: completed
  - id: t08-runtime
    content: T-08 Trusted resolve + hosted HTTP connector with hostname allowlist SSRF guards
    status: completed
  - id: t09-tests-docs
    content: T-09 Isolation tests + README + CHANGELOG + CI on dest
    status: completed
  - id: t10-deploy
    content: T-10 Fly (1 Machine) + Neon + Cloudflare + PostgresStore + GH Actions
    status: completed
  - id: t11-agentpass
    content: T-11 AgentPass Authority — Phase 2, not first Build
    status: completed
isProject: false
---

# Agent grant vault product (reviewed)

Canonical artifact (full contracts, ACs, research): [grant_vault_product_1a24ec63.plan.md](/Users/naffis/.cursor/plans/grant_vault_product_1a24ec63.plan.md). Research twin: [docs/plans/2026-08-30-grant-vault-product.md](docs/plans/2026-08-30-grant-vault-product.md). Topology: [.loadout/tasks/grant-vault-product/TASK.md](.loadout/tasks/grant-vault-product/TASK.md).

You store named credentials **once**. Agents request use. You authorize. The runtime (hosted connector or trusted resolve) gets the value. The model never does.

**Where it runs:** Fly.io Machines (Node 22, `iad`), **one Machine per app**, Neon Postgres (two projects), Cloudflare DNS + WAF. Local CLI stays sqlite. First **Build** is T-01…T-10 only (A-9).

## Review locks that changed this pass

- **P0 MCP affinity:** Streamable HTTP keeps `Mcp-Session-Id` in process memory. Two Fly Machines without [fly-replay](https://fly.io/docs/blueprints/sticky-sessions/) break vendor sessions. v1 is one Machine. T-10b (not first Build) adds affinity before `count = 2`.
- **P0 standing policies:** `policies` table. Matching `request_grant` auto-activates (R-15, AC-12). R-04 only applies when no standing policy exists.
- **P0 operator revoke:** `POST /api/grants/:id/revoke` stays. MCP `revoke_grant` is removed (AC-13).
- **P0 /health leak:** live [src/server.ts](src/server.ts) returns `vault.fingerprint`. Strip it (AC-14). Port default today is 8787; ship 8788.
- **P1:** Neon pooled vs `DATABASE_URL_DIRECT`; full Fly secret name list; GH cron dump; Fly app vs vault env; Clerk Organizations (A-10).

## Design (unchanged core)

D-01 Clerk AS + CIMD/DCR. D-03 KEK/DEK. D-08 connector SSRF. D-10 AgentPass is Phase 2 Authority, not a vault replacement. D-11 Fly + Neon + Cloudflare.

## Topology

Pipeline, shared trunk, concurrency 1. Escalation tests FAIL (shared kernel files).

## Gate

`npm test && npm run typecheck`. Proves R-01…R-16 via AC-01…AC-14.

Do not implement until Build or an explicit implement ask.
