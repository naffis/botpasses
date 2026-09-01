# Botpasses

Named credentials for **agents and tools**, injected into the **runtime** (child env, hosted connector, or trusted resolve). Never into the **model context or transcript**.

This is not a human password manager. It does not do browser autofill, TOTP, passkeys, or sharing secrets with other people. If the LLM can see a secret value, the product failed.

Hosted origins: **https://botpasses.com** (prod) and **https://staging.botpasses.com**. MCP collect URLs, CLI login, OAuth resource, and emails use those origins only. Process env names stay `VAULT_*`. AgentPass (`/agentpass/*`) is a separate protocol, not the product name.

An existing local sqlite tree at `~/.agent-vault` is ignored unless you set `VAULT_HOME` to that path.

## Product intent

You store named credentials **once**. Agents request use. You authorize with a policy. The runtime gets the value. The model never does.

Local CLI (`VAULT_MODE` unset) stays a single-operator sqlite kernel for `vault run`. Hosted (`VAULT_MODE=hosted`) is the multi-user product: Clerk orgs, Neon Postgres, Fly (one Machine), Cloudflare WAF.

## v1 local path

1. `vault set NAME` — store encrypted at rest. Output is `NAME ••••last4`.
2. Agent calls MCP `request_grant` for a named secret and named tool.
3. Operator approves with `vault grant` (once or session) or the loopback console.
4. `vault run --with NAME --agent AGENT --tool TOOL -- command` injects the value into the child env.
5. `vault revoke` and `vault audit` — operator only. MCP does not revoke.
6. Listen port is **8788** (not 8787; that port is reserved for Cursor MCP OAuth).

## Hosted path

Operators in a Clerk Organization store `secret` or `login` items per vault environment (`staging` | `production`). Model clients (Grok, Claude, ChatGPT, Cursor) use remote MCP: `find_items`, `list_items`, `request_grant`, `list_grants`, `http.request`. `find_items` matches an exact `item_name` and/or exact API `host` (for example `api.spotify.com`). If nothing matches, MCP returns a path-only `collect_url` on Botpasses. Sign in there and type the secret. Never paste it into chat. Standing policies skip the inbox. Trusted apps call `POST /runtime/resolve` with an `avt_…` key. Model tokens cannot resolve. Connector `http.request` uses the item's exact `allowed_hosts`, rejects IP literals, DNS-pins to public addresses, and does not follow redirects.

Connector display name for Claude: **Botpasses** (ASCII). MCP `serverInfo.name` is `botpasses`.

### Vendor connect

| Client | How |
| --- | --- |
| Grok Bot | Custom connector URL `https://<origin>/mcp` plus `Authorization: Bearer avm_…` (issue from the operator console). Grok Bot is a cloud VM; local stdio MCP is not reachable. |
| Grok Build | `grok mcp add --transport http botpasses https://<origin>/mcp --header "Authorization: Bearer ${BOTPASSES_MODEL_TOKEN}"` |
| Claude | Remote connector named `Botpasses` + OAuth |
| ChatGPT | Remote MCP requires OAuth 2.1 + Dynamic Client Registration (enable DCR on the Clerk instance) |
| Cursor | Remote MCP URL or local `npx vault mcp` stdio. Hosted stdio: `npx vault login`, then `npx vault mcp --user-jwt` |

Until the package is published on npm, use `npx vault` from this repo or `npm run botpasses`.

### Hosted MCP stdio

Do not put `CLERK_SECRET_KEY` in `mcp.json`. Sign in at the hosted origin, copy the Clerk **session** JWT, then:

```bash
export VAULT_PUBLIC_URL=https://staging.botpasses.com
npx vault login
export VAULT_USER_JWT=eyJ...
npx vault mcp --user-jwt
```

### Grant policies

| Policy | Behavior |
| --- | --- |
| `prompt` | One connector call or resolve, then consumed |
| `session` | Active until TTL (8h) or revoke |
| `item_standing` | Later `request_grant` for that client+item is already active |
| `folder_standing` | Owner only. Requires `confirm_name`. Later requests in that folder/env auto-activate |

Approve via web inbox, Resend magic link, or the 8-digit code returned by `request_grant`.

## What this is not

- A LastPass / 1Password / Bitwarden clone
- Browser login filling, TOTP, or passkeys as a product
- An MCP/API tool that returns plaintext to the model (`get_secret` does not exist)
- Two Fly Machines in v1 (MCP Streamable HTTP session is in-process)

## Threat model

| Surface | Sees secret value? |
| --- | --- |
| MCP tools (`find_items`, `list_items` / `list_secrets`, `request_grant`, `list_grants`, `http.request`) | **No** — names, last-4, username, grant status, `collect_url`, redacted origin body |
| Operator console / HTTP JSON (except trusted resolve) | **No** after submit — name + last-4 |
| CLI `list` / `grant` / `audit` | **No** |
| Audit table | **No** — no value column |
| Items table | Ciphertext only (AES-256-GCM) |
| `vault run` child env / trusted `/runtime/resolve` / connector origin | **Yes** — that is the inject |
| Model context / chat transcript | **Must not.** Tests fail if a canary appears |

## Hard rules

- No MCP/API tool returns secret **values** to the model.
- MCP may list **names**, find by name or host, request a grant, report grant status, call `http.request`. On a miss it returns a Botpasses `collect_url` (no HMAC). The operator types the secret on that origin.
- Revoke is operator-only (`POST /api/grants/:id/revoke` or `vault revoke`).
- Values stay in the vault process until inject.
- Tests prove a mocked conversation cannot contain the stored secret after store, grant, or use.

## Requirements

- Node.js 22.14+
- Local: `VAULT_MASTER_KEY` — 32 bytes as **64 hex characters** (preferred) or standard base64
- Hosted: `VAULT_KEK` (same encoding) plus Neon `DATABASE_URL`

## How to run locally

```bash
npm install
export VAULT_HOME="$PWD/.botpasses"
npx vault init
printf '%s' 'sk_test_example_not_real' | npx vault set STRIPE_KEY
npx vault list
npx vault grant --secret STRIPE_KEY --agent invoicer --tool stripe --once
npx vault run --with STRIPE_KEY --agent invoicer --tool stripe -- \
  node -e 'console.log("injected", Boolean(process.env.STRIPE_KEY), "last4", (process.env.STRIPE_KEY||"").slice(-4))'
npx vault audit
npx vault revoke --secret STRIPE_KEY --agent invoicer --tool stripe
```

Default home when `VAULT_HOME` is unset is `$HOME/.botpasses`.

### Operator console + HTTP + MCP (one process)

```bash
npx vault serve --host 127.0.0.1 --port 8788
```

- Console: `http://127.0.0.1:8788/` — store, approve, revoke, audit.
- JSON: `/api/secrets`, `/api/grants`, `/api/audit` — metadata only.
- MCP JSON-RPC: `POST /mcp`
- `GET /health` — `{ ok, product: "botpasses" }` with **no** key fingerprint

### MCP (stdio)

```json
{
  "mcpServers": {
    "botpasses": {
      "command": "npx",
      "args": ["vault", "mcp"],
      "env": {
        "VAULT_HOME": "/absolute/path/.botpasses",
        "VAULT_MASTER_KEY": "set-me"
      }
    }
  }
}
```

| Tool (local) | Returns |
| --- | --- |
| `list_secrets` | names, last-4, timestamps |
| `request_grant` | pending grant metadata |
| `list_grants` | grant status |

There is no `get_secret` / `read_value` / `revoke_grant` on MCP. Approval and revoke are operator surfaces.

## CLI

| Command | Purpose |
| --- | --- |
| `vault init` | Create `$VAULT_HOME` + SQLite schema; generate key if needed |
| `vault set NAME` | Encrypt and store. Prints name + last-4 |
| `vault list` | Names + last-4 |
| `vault grant --secret NAME --agent A --tool T [--once\|--session] [--ttl 8h]` | Human approval |
| `vault revoke --id GRANT_ID` | Stop future injects |
| `vault audit` | Grant/revoke/store/inject events, no values |
| `vault run --with NAME --agent A --tool T -- CMD` | Inject into child env without printing |
| `vault serve` | Loopback HTTP + operator console + `/mcp` (port 8788) |
| `vault login` | Print hosted stdio steps (`VAULT_PUBLIC_URL` + Clerk session JWT) |
| `vault mcp` | MCP stdio (local sqlite). `vault mcp --user-jwt` proxies hosted MCP over the session JWT |

`VAULT_MODE=hosted` on `vault serve` starts the hosted process (Postgres). Do not set `VAULT_HOME` in that mode (exit 78).

## Encryption

Local: AES-256-GCM envelope with `VAULT_MASTER_KEY`. Hosted: platform `VAULT_KEK` wraps a per-org DEK; item encrypt uses the org DEK with AAD `org_id`.

## Hosted deploy (Fly + Neon + Cloudflare)

Two Fly apps (`botpasses-staging`, `botpasses-prod`), **one Machine each** in `iad`. Staging and production keep **separate Neon databases** (reuse the existing `DATABASE_URL` secrets; do not branch prod from staging). Cloudflare orange-cloud DNS + WAF, SSL Full (strict). Cutover steps: [docs/ops/botpasses-cutover.md](docs/ops/botpasses-cutover.md). Identity decisions: [docs/adr/0001-botpasses-identity.md](docs/adr/0001-botpasses-identity.md), origins [docs/adr/0002-botpasses-com-origin.md](docs/adr/0002-botpasses-com-origin.md).

**DNS:** orange-cloud `A`/`AAAA` for `botpasses.com` and `staging.botpasses.com`, plus grey-cloud `_fly-ownership` TXT. `www.botpasses.com` is a Cloudflare 301 to the apex (no Fly cert).

**Fly secrets (names only):** `VAULT_KEK`, `DATABASE_URL` (Neon pooled `-pooler` host), `DATABASE_URL_DIRECT` (migrations and `pg_dump`), `VAULT_BOOTSTRAP_TOKEN` (32+ chars; operator login until Clerk), `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_FRONTEND_API` (hostname only, e.g. `clerk.staging.botpasses.com`), `RESEND_API_KEY`, `VAULT_EMAIL_FROM` (`Botpasses <noreply@mail.botpasses.com>`), `VAULT_PUBLIC_URL`, `VAULT_APPROVAL_HMAC`, `SENTRY_DSN`. Prod also: `BACKUP_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Hosted boot exits 78 if `RESEND_API_KEY` is set and `VAULT_EMAIL_FROM` is empty.

Staging Fly app sets `VAULT_DEPLOY_PLANE=staging` and refuses vault environment `production`. Rollback: `fly releases rollback` on that app; Neon PITR if data is wrong.

Push to `dev` runs tests then `flyctl deploy -c fly.staging.toml`. Production is `workflow_dispatch` after a named staging SHA is green. Nightly `backup-prod.yml` (`0 4 * * *` UTC) dumps via `DATABASE_URL_DIRECT`, AES-256-GCM with `BACKUP_KEY`, puts `botpasses-${STAMP}.dump.enc` in R2.

AgentPass Authority (`/agentpass/*`) stays dark unless `VAULT_AGENTPASS=1`.

## Tests

```bash
npm test
npm run typecheck
```

Isolation tests store a canary value and fail if it appears in MCP, REST model payloads, audit JSON, email HTML, or connector tool results. Hosted AC-10/AC-11 run when `DATABASE_URL` points at Postgres 16 (CI service).

## Layout

```
src/           local kernel, hosted kernel, stores, MCP, HTTP
test/          isolation, MCP, CLI, HTTP, hosted ACs
migrations/    hosted SQL
fly.staging.toml / fly.prod.toml
```
