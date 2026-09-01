# Changelog

## 0.3.3 — 2026-08-31

Public origins are **botpasses.com**, not botpasses.ai.

- Prod `https://botpasses.com`, staging `https://staging.botpasses.com`.
- Documented Clerk FAPI `clerk.botpasses.com` / `clerk.staging.botpasses.com` and Resend `mail.botpasses.com`.
- Hosted boot requires `VAULT_PUBLIC_URL` to match the deploy plane origin. MCP, CLI, and emails never use a platform default hostname.
- Canonical constants: `src/brand.ts`. Identity ADR: [0002](docs/adr/0002-botpasses-com-origin.md).

## 0.3.2 — 2026-08-30

Agents can find named credentials and operators can enter a missing key on Botpasses without the model seeing the value.

- MCP `find_items` matches an exact `item_name` and/or exact API hostname. Results are `found`, `ambiguous` (up to 5, with `allowed_hosts`), `host_mismatch`, or `need_item`.
- A miss returns a path-only `collect_url` (`/collect/{needId}`, no query HMAC). Sign in on Botpasses and POST fulfill as the operator. Model and trusted tokens cannot fulfill.
- Fulfill stores the item and an active prompt grant for the requesting client, then `http.request` injects in-process. Local MCP miss tells the operator to `vault store` and does not mint a collect URL.
- Inbox lists pending needs next to grants. Console store form uses an inject select and host example `api.spotify.com`.

## 0.3.1 — 2026-08-30

Hosted console and Grok Bot can run without Clerk.

- Operator HTML at `/` is public; APIs still require auth. Paste `VAULT_BOOTSTRAP_TOKEN` (32+ chars) to operate.
- `POST /api/clients/model` issues a one-time `avm_…` bearer for remote MCP (Grok Bot header auth). `avt_…` trusted tokens still cannot call MCP. Model tokens still cannot `/runtime/resolve`.
- Process env: `VAULT_BOOTSTRAP_TOKEN`.
- GitHub repository is `naffis/botpasses` (old `naffis/agent-vault` URL redirects).

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
