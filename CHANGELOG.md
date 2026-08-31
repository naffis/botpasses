# Changelog

## 0.3.1 — 2026-08-30

Hosted console and Grok Bot can run without Clerk.

- Operator HTML at `/` is public; APIs still require auth. Paste `VAULT_BOOTSTRAP_TOKEN` (32+ chars) to operate.
- `POST /api/clients/model` issues a one-time `avm_…` bearer for remote MCP (Grok Bot header auth). `avt_…` trusted tokens still cannot call MCP. Model tokens still cannot `/runtime/resolve`.
- Process env: `VAULT_BOOTSTRAP_TOKEN`.

## 0.3.0 — 2026-08-30

Product identity is **Botpasses**. Hosted origins are `https://botpasses.ai` and `https://staging.botpasses.ai`.

- Display name, MCP `serverInfo.name`, `/health` `product`, and npm package name are `botpasses` / Botpasses.
- CLI bins: `botpasses` and `vault` (same entry). Default local home is `$HOME/.botpasses`.
- Fly apps: `botpasses-staging`, `botpasses-prod`. Nightly backup object prefix is `botpasses-`.
- Hosted email From comes from `VAULT_EMAIL_FROM` (required at boot when `RESEND_API_KEY` is set).
- Process env prefix stays `VAULT_*`. AgentPass paths are unchanged.

## 0.2.0 — 2026-08-30

Hosted multi-user grant vault (Fly + Neon + Cloudflare) alongside the local sqlite CLI.

- Store `secret` and `login` items per org environment (`staging` | `production`).
- Grant policies: `prompt`, `session`, `item_standing`, `folder_standing` (standing rows short-circuit `request_grant`).
- Operator approve via web inbox, Resend magic link, or hashed 8-digit code. MCP has no `revoke_grant`; operator `POST /api/grants/:id/revoke` remains.
- Model MCP tools: `list_items`, `request_grant`, `list_grants`, `http.request`. Connector attaches the granted credential to the item allowlist, DNS-pins the origin, and redacts values from the result.
- Trusted clients call `POST /runtime/resolve`. Model tokens cannot.
- Local `vault serve` listens on **8788**. `/health` no longer includes a key fingerprint.
- Hosted process (`VAULT_MODE=hosted`) uses Neon Postgres, refuses `VAULT_HOME` (exit 78), one Fly Machine per app.
- Hosted MCP stdio: `vault login` then `vault mcp --user-jwt` with `VAULT_PUBLIC_URL` and a Clerk session JWT (never `CLERK_SECRET_KEY`).
- AgentPass Authority HTTP is dark unless `VAULT_AGENTPASS=1`.
