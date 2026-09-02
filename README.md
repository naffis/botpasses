# Botpasses

Named credentials for **agents and tools**, injected into the **runtime** (child env, hosted connector, or trusted resolve). Never into the **model context or transcript**.

This is not a human password manager. It does not do browser autofill, TOTP, passkeys, or sharing secrets with other people. If the LLM can see a secret value, the product failed.

Hosted origins: **https://botpasses.com** (prod) and **https://staging.botpasses.com**. MCP collect URLs, CLI login, OAuth resource, and emails use those origins only. Process env names stay `VAULT_*`. AgentPass (`/agentpass/*`) is a separate protocol, not the product name.

An existing local sqlite tree at `~/.agent-vault` is ignored unless you set `VAULT_HOME` to that path.

## Product intent

You store named credentials **once**. Agents request use. You authorize with a policy. The runtime gets the value. The model never does.

Local CLI (`VAULT_MODE` unset) stays a single-operator sqlite kernel for `vault run`. Hosted (`VAULT_MODE=hosted`) is the multi-user product: first-party operator accounts (email OTP + TOTP), same-origin OAuth, Neon Postgres, Fly (one Machine), Cloudflare WAF.

## v1 local path

1. `vault set NAME` — store encrypted at rest. Output is `NAME ••••last4`.
2. Agent calls MCP `request_grant` for a named secret and named tool.
3. Operator approves with `vault grant` (once or session) or the loopback console.
4. `vault run --with NAME --agent AGENT --tool TOOL -- command` injects the value into the child env.
5. `vault revoke` and `vault audit` — operator only. MCP does not revoke.
6. Listen port is **8788** (not 8787; that port is reserved for Cursor MCP OAuth).

## Hosted path

Operators create an account on this origin (email OTP, then TOTP) and store `secret` or `login` items per vault environment (`staging` | `production`). Model clients (Grok, Claude, ChatGPT, Cursor) use remote MCP: `find_items`, `list_items`, `request_grant`, `list_grants`, `http.request`. `find_items` matches an exact `item_name` and/or exact API `host` (for example `api.spotify.com`). If nothing matches, MCP returns a path-only `collect_url` on Botpasses. Sign in there and type the secret. Never paste it into chat. Standing policies skip the inbox. Trusted apps call `POST /runtime/resolve` with an `avt_…` key. Model tokens cannot resolve. Connector `http.request` uses the item's exact `allowed_hosts`, rejects IP literals, DNS-pins to public addresses, and does not follow redirects. Revoke clients, grants, and sessions from the console Access panel.

Connector display name for Claude: **Botpasses** (ASCII). MCP `serverInfo.name` is `botpasses`.

### Vendor connect

| Client | How |
| --- | --- |
| Grok Bot | Custom connector URL `https://<origin>/mcp` plus `Authorization: Bearer avm_…` (issue from the operator console). Grok Bot is a cloud VM; local stdio MCP is not reachable. After it is connected, ask in plain language (get my Spotify profile). Grok should call `http.request` in the same turn. You approve in the inbox if asked. You do not need to name Botpasses tools. |
| Grok Build | `grok mcp add --transport http botpasses https://<origin>/mcp --header "Authorization: Bearer ${BOTPASSES_MODEL_TOKEN}"` |
| Claude | Remote connector named `Botpasses` + OAuth |
| ChatGPT | Remote MCP requires OAuth 2.1 + Dynamic Client Registration on this origin |
| Cursor | Remote MCP URL or local `npx vault mcp` stdio. Hosted stdio: `npx vault login`, then `npx vault mcp --user-jwt` |

Until the package is published on npm, use `npx vault` from this repo or `npm run botpasses`.

### Hosted MCP stdio

Sign in at `/sign-in`, then open `/console`. Device login is `/device`. Connect MCP to this origin (it is the authorization server):

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

- A LastPass / 1Password / Bitwarden clone. Botpasses is a **grant-vault**: the hosted process decrypts at inject. The vendor can read keys if it has the KMS role and the database. We do not claim otherwise.
- Browser login filling, TOTP, or passkeys as a product
- An MCP/API tool that returns plaintext to the model (`get_secret` does not exist)
- Two Fly Machines in v1 (MCP Streamable HTTP is stateless per request)

## Threat model

Full table: [docs/security/threat-model.md](docs/security/threat-model.md). Decisions: [0003](docs/adr/0003-grant-vault-trust-model.md), [0004](docs/adr/0004-kms-wrapped-kek.md).

| Surface | Sees secret value? |
| --- | --- |
| MCP tools (`find_items`, `list_items` / `list_secrets`, `request_grant`, `list_grants`, `http.request`) | **No** — names, last-4, username, grant status, `collect_url`, redacted origin body |
| Operator console / HTTP JSON (except trusted resolve) | **No** after submit — name + last-4 |
| CLI `list` / `grant` / `audit` | **No** |
| Audit table | **No** — no value column |
| Items table | Ciphertext only (AES-256-GCM) |
| `vault run` child env / trusted `/runtime/resolve` / connector origin | **Yes** — that is the inject |
| Hosted Fly process / KMS role (after unwrap) | **Yes** at inject. Required for `http.request`. |
| Botpasses staff without KMS + DB | **No** |
| Neon dump without the platform KEK / KMS | **No** |
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
- Hosted: Neon `DATABASE_URL` plus `VAULT_KEK_WRAPPED` (after cutover) or raw `VAULT_KEK` (pre-cutover fallback)

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
| `vault serve` | Loopback HTTP + operator console + `/mcp` (port 8788). Prints an HMAC loopback bearer. Required on `/api` and `POST /mcp`. |
| `vault login` | Print `/sign-in`, `/console`, and `/device` on the hosted origin |
| `vault mcp` | MCP stdio (local sqlite). `vault mcp --user-jwt` proxies hosted MCP over an access token |

`VAULT_MODE=hosted` on `vault serve` starts the hosted process (Postgres). Do not set `VAULT_HOME` in that mode (exit 78).

## Encryption

Local: AES-256-GCM envelope with `VAULT_MASTER_KEY` (AAD is the secret name). Hosted: AWS KMS unwraps the platform KEK at boot (`VAULT_KEK_WRAPPED`); that KEK wraps a per-org DEK; item encrypt uses the org DEK with AAD `org_id`. Before cutover, raw `VAULT_KEK` still boots (`VAULT_KEK_REQUIRE_KMS` unset). After cutover, set `VAULT_KEK_REQUIRE_KMS=1` and unset the raw key. Runbook: [docs/ops/kek-rotation.md](docs/ops/kek-rotation.md).

## Hosted deploy (Fly + Neon + Cloudflare)

Two Fly apps (`botpasses-staging`, `botpasses-prod`), **one Machine each** in `iad`. Hosted data is Neon Postgres, not Machine sqlite. Staging and production must be **separate Neon projects**. Do not branch prod from staging. Cloudflare orange-cloud DNS + WAF, SSL Full (strict). Cutover: [docs/ops/botpasses-cutover.md](docs/ops/botpasses-cutover.md). Restore and offsite dumps: [docs/ops/restore.md](docs/ops/restore.md). Identity: [0001](docs/adr/0001-botpasses-identity.md), origins [0002](docs/adr/0002-botpasses-com-origin.md), operator auth [0003](docs/adr/0003-first-party-operator-identity.md), OAuth [0004](docs/adr/0004-same-origin-oauth-as.md), Access [0005](docs/adr/0005-access-ledger.md).

**DNS:** orange-cloud `A`/`AAAA` for `botpasses.com` and `staging.botpasses.com`, plus grey-cloud `_fly-ownership` TXT. `www.botpasses.com` is a Cloudflare 301 to the apex (no Fly cert).

**Fly secrets (names only):** `VAULT_KEK_WRAPPED`, `VAULT_KMS_KEY_ID`, `AWS_ROLE_ARN`, `VAULT_KEK_REQUIRE_KMS` (set `1` after wrap is confirmed), raw `VAULT_KEK` (pre-cutover fallback only), `DATABASE_URL` (Neon pooled `-pooler` host), `DATABASE_URL_DIRECT` (migrations), `VAULT_SESSION_SECRET` (≥32 bytes), `VAULT_OIDC_PRIVATE_JWK` (RS256 private JWK), `VAULT_BOOTSTRAP_TOKEN` (32+ chars; break-glass), `RESEND_API_KEY` (sending-access, domain-scoped), `VAULT_EMAIL_FROM` (`Botpasses <noreply@staging.botpasses.com>` on staging, `Botpasses <noreply@botpasses.com>` on production), `VAULT_PUBLIC_URL`, `VAULT_APPROVAL_HMAC`, `SENTRY_DSN`. Hosted boot exits 78 if `RESEND_API_KEY` is set and `VAULT_EMAIL_FROM` is empty, if the session secret is short, if the JWK is missing, or if `site/dist/index.html` is missing.

**GitHub Actions secrets for `backup-prod.yml`:** `DATABASE_URL_DIRECT`, `BACKUP_KEY` (32-byte hex, not the vault KEK), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. The workflow reads repo Actions secrets, not Fly secrets. Missing R2 fails the job.

Staging Fly app sets `VAULT_DEPLOY_PLANE=staging` and refuses vault environment `production`. Rollback: `fly releases rollback` on that app; Neon PITR if data is wrong.

Push to `dev` runs tests then `flyctl deploy -c fly.staging.toml`. Production is `workflow_dispatch` after a named staging SHA is green. `backup-prod.yml` (`0 4 * * *` UTC plus `workflow_dispatch`) dumps via `DATABASE_URL_DIRECT`, encrypts with `BACKUP_KEY` (not the vault KEK), and uploads to R2. The job fails if R2 secrets are missing. GitHub only runs `schedule` and `workflow_dispatch` from the default branch. Point that at `dev` after Actions secrets exist (see [docs/ops/restore.md](docs/ops/restore.md)). Do not enable the cron while those secrets are missing.

AgentPass Authority (`/agentpass/*`) stays dark unless `VAULT_AGENTPASS=1`.

## Documentation

Public (this origin after `site` build):

- [MCP tools](site/src/pages/docs/reference/mcp-tools.astro)
- [HTTP API](site/src/pages/docs/reference/http-api.astro)
- [CLI](site/src/pages/docs/reference/cli.astro)

Internal (engineers, file pointers, local vs hosted):

- [docs/reference/mcp.md](docs/reference/mcp.md)
- [docs/reference/http-api.md](docs/reference/http-api.md)

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
