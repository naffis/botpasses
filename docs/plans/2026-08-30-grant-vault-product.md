# Plan: Agent grant vault product

Canonical interactive plan: `~/.cursor/plans/grant_vault_product_1a24ec63.plan.md`.

This file is the create-plan research twin. Do not implement from this file alone; Build uses the Cursor plan.

## 1. Summary

- Problem: Local unauthenticated kernel cannot serve Grok/Claude/ChatGPT/apps, cannot store logins, cannot offer flexible grants, and cannot recover view-once keys.
- Outcome: Multi-user hosted grant vault: store once, approve with policies, inject via our connector or trusted resolve. The model does not get those keys.
- Approach: Keep the Node 22 TypeScript kernel; add Clerk, Resend, `VaultStore` (sqlite local / Neon hosted), remote MCP, connector with SSRF guards. Deploy on Fly Machines behind Cloudflare. Do not rewrite onto D1/Workers.

## 2. Scope

### In scope

Multi-user orgs, secret+login items, four grant policies, web/email/code approval, MCP OAuth + REST + stdio, trusted resolve, hosted `http.request`, Fly+Neon+Cloudflare staging/prod.

### Non-goals (with rationale)

- Native mobile app — web + email + code cover approve-on-phone.
- Browser autofill / TOTP / passkeys / 1Password import — DAV-42 skips.
- `get_secret` on model tokens — product failure.
- D1/Workers/Cloudflare Containers stateful vault — no BEGIN / ephemeral disk / no DNS-pin SSRF.
- Cloudflare Tunnel as product ingress — lab pattern; Fly + Cloudflare DNS/WAF instead.
- Hosted sqlite-on-volume or LiteFS — no PITR; LiteFS can lose writes.
- Auto-migrate `~/.agent-vault` — operators re-store.
- Replace the vault with AgentPass — different job (task auth at a Service vs stored credentials). Spec is v0.1 draft, not production-audited.
- v1 AgentPass Authority HTTP — Phase 2 (T-11). v1 only stores `task_id` / `task_description` on grants.

### Assumptions

See Cursor plan A-1…A-10.

### Open questions

None.

## 3. Current state

- Files read: `src/types.ts`, `src/vault.ts`, `src/mcp.ts`, `src/server.ts`, `src/db.ts`, `src/cli.ts`, `src/crypto.ts`, `package.json`, `README.md`.
- What exists: single-user AES-GCM sqlite, `once|session` grants, unauthenticated HTTP, stdio MCP, `vault run` only inject.
- Data flow: CLI/HTTP/MCP → Vault → sqlite envelopes; decrypt only in `runWithSecrets`.
- Gaps: no users, no login items, no remote auth, no connector, MCP can revoke.
- Deps: none runtime; Node ≥22.14.

## 4. External research

### Questions investigated

1. Can D1 do atomic once-consume?
2. Can Clerk be the MCP AS including ChatGPT DCR?
3. Do ChatGPT/Claude require more than Grok’s header auth?
4. How should multi-tenant envelope keys work without per-org Worker secrets?
5. Can Workers safely egress user-controlled HTTP?
6. Should we adopt [AgentPass](https://agentpass.com/) as the vault, or as an extra protocol?
7. What production host and store scale past a Tunnel + disk sqlite?

### Sources consulted

| Source | URL | Takeaway |
| ------ | --- | -------- |
| 1Password Environments MCP | https://www.1password.dev/environments/mcp-server | Names only; local-only — reject as sole path |
| Infisical Agent Proxy | https://infisical.com/docs/documentation/platform/agent-proxy/overview | Adopt as our connector |
| MCP authorization | https://modelcontextprotocol.org/specification/2025-11-25/basic/authorization | Resource server + PRM |
| xAI MCP | https://docs.x.ai/build/features/mcp-servers | HTTP + OAuth; header fallback |
| Clerk MCP | https://clerk.com/docs/expressjs/guides/ai/mcp/build-mcp-server | CIMD + DCR; `@clerk/mcp-tools` |
| Remote MCP 2026 | https://apigene.ai/blog/remote-mcp-servers | ChatGPT requires DCR |
| WorkOS envelope | https://workos.com/blog/envelope-encryption-explained | KEK wraps per-org DEK |
| D1 transactions | https://dev.to/hirodeath/cloudflare-d1-has-no-begin-transaction-so-i-tested-its-limits-and-the-batch-api-5813 | No BEGIN — reject D1 |
| Workers SSRF | https://github.com/devslab-kr/ssrf-guard-js/blob/main/README.md | No DNS pin — reject Workers egress |
| CIBA | https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow/mobile-push-notifications-with-ciba | Later, not v1 |
| AgentPass | https://agentpass.com/ | Task-scoped single-use pass; not a secret store |
| AgentPass spec | https://agentpass.com/spec | v0.1 draft; Authority/Harness/Service; do not use as v1 prod auth |
| clerk/agentpass | https://github.com/clerk/agentpass | Canonical spec repo |
| Fly + Cloudflare | https://fly.io/docs/networking/understanding-cloudflare/ | Orange-cloud + `_fly-ownership`; Full (strict) |
| Fly GH Actions | https://fly.io/docs/launch/continuous-deployment-with-github-actions/ | `dev` → staging; dispatch → prod |
| Fly secrets | https://fly.io/docs/apps/secrets/ | KEK and DATABASE_URL per app |
| LiteFS | https://fly.io/docs/litefs/ | Reject: async loss; autostop hazard |
| CF Containers | https://developers.cloudflare.com/containers/faq/ | Reject: ephemeral disk |
| Neon backups | https://neon.com/docs/manage/backups | PITR + pg_dump to R2 |
| CF connection limits | https://developers.cloudflare.com/fundamentals/reference/connection-limits/ | 100s proxy read → MCP keepalive |

### Implications

Adopt Node on Fly + Neon + Cloudflare WAF + Clerk + connector. Reject D1, Workers egress, CF Containers, Tunnel-as-product, LiteFS, hosted sqlite, get_secret, native app.

**AgentPass:** Adapt as Phase 2 Authority (T-11), not as v1 foundation. Complementary to stored secrets. See Cursor plan D-10.

## 5–12

Requirements, ADRs, tasks, topology, tests, rollout, risks, DoD: see the Cursor plan (same IDs R-01…R-16, D-01…D-11, T-01…T-11, AC-01…AC-14). First Build is T-01…T-10. v1 Fly topology is **one Machine** per app (MCP session affinity).
