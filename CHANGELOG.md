# Changelog

## Unreleased

- Sign-in, sign-up, enroll, consent, device, and collect use the same brand fonts and card chrome as `/console`. Verify is hidden until a code is sent. Inbox needs say Store the credential. Vault empty offers Store credential. Connect copies the MCP URL and one-time token. Rotate no longer shows the item id.
- Staging console lists and stores only staging items. `GET /api/items` with no environment returns every env this deploy plane serves (staging only on staging; both on production). Explicit `environment=production` on staging is still 404. Failed Store, Rotate, or delete/revoke show the API error inside the open dialog. A failed Access snapshot shows an error, not an empty panel. Collect and approve-by-code still flash on the page. Issue Grok uses the same environment list as Store. Secret fields stay filled until the request succeeds.
- Console and collect pick how a credential is sent from Kind (API token → Bearer, username and password → HTTP Basic). Inject is behind “Change how it is sent.” Username stays hidden unless Basic is in use.
- `/enroll-totp` shows a local QR code, an `otpauth://` link, and the grouped secret after `POST /api/auth/totp/start`. The QR is SVG generated on this origin (not a third-party image).
- Hosted mail sends through Resend on the verified public hosts. Staging From is `Botpasses <noreply@staging.botpasses.com>`; production is `Botpasses <noreply@botpasses.com>`. Fly uses a sending-access key per plane.
- Public and internal MCP + HTTP API reference: hosted tools (`http.request`, find, grant), operator `/api`, OAuth, local `vault serve`. No `get_secret`.

## 0.4.1 — 2026-08-31

Grant-vault hardening: honest trust model, KMS-wrapped KEK, surface locks.

- Hosted is a grant-vault, not zero-knowledge. ADRs [0003-grant-vault](docs/adr/0003-grant-vault-trust-model.md) and [0004-kms](docs/adr/0004-kms-wrapped-kek.md). Threat table: [docs/security/threat-model.md](docs/security/threat-model.md).
- AWS KMS unwraps the platform KEK at boot (`VAULT_KEK_WRAPPED`). Expand/contract: raw `VAULT_KEK` still boots until `VAULT_KEK_REQUIRE_KMS=1`. `vault kek-wrap` / `vault kek-rotate` on a laptop. Runbook: [docs/ops/kek-rotation.md](docs/ops/kek-rotation.md).
- Hosted HTML/JSON: CSP nonce, DENY frames, nosniff, HSTS, `no-store`. Disallowed CORS Origin is 403 with no ACAO.
- Collect GET is a shell. Need details require an operator `GET /api/need-items/:id`.
- Store-backed org rate limit. `POST /api/clients/:id/rotate` invalidates the old `avm_` / `avt_` hash.
- Local envelopes bind AAD to the secret name (migrate-on-open). `vault serve` requires `HMAC-SHA256(master, "botpasses-loopback")` on `/api` and `POST /mcp`.
- CI: `npm audit --omit=dev --audit-level=high`. Dependabot weekly for npm.

## 0.4.0 — 2026-08-31

Marketing site, first-party operator accounts, same-origin OAuth, and the Access panel. Clerk is removed.

- Hosted `/` is the Astro marketing site. Console is `/console`. Design tokens live at `/design`.
- Operators create an account with email OTP and required TOTP. Sessions are HttpOnly cookies plus signed CSRF.
- This origin is the MCP authorization server (`oidc-provider` 9.12). PKCE S256 only. Access JWTs `aud=${origin}/mcp`, 600s. RFC 7009 `/oauth/revoke`.
- Access panel lists operators, clients, grants, sessions, and the issuance ledger. Revoke a client, grant, or other session from that screen.
- Env: `VAULT_SESSION_SECRET`, `VAULT_OIDC_PRIVATE_JWK`. No `CLERK_*`.
- ADRs [0003](docs/adr/0003-first-party-operator-identity.md), [0004](docs/adr/0004-same-origin-oauth-as.md), [0005](docs/adr/0005-access-ledger.md).

## 0.3.4 — 2026-08-31

MCP tells the model when to use Botpasses, so the user does not have to paste a procedure.

- Hosted `initialize` instructions: if the user wants a third-party API called, run `http.request` **in the same turn**. Do not `list_items` first. Example: "get my Spotify profile" → `GET https://api.spotify.com/v1/me`. Never ask for a secret in chat.
- `http.request` is the primary tool: `host` or a full https `path` URL is enough. It finds the credential, requests a grant when inject is denied, and returns `next.for_model` plus `next.arguments` to retry.
- Concurrent prompt consume still hits the origin once. The other call returns a pending grant (not `inject_denied`), so the model can ask the operator to approve again.
- `need_item` is not MCP `isError` (models stop on errors). `host_mismatch` still is.
- Tool and param descriptions state when to use each tool versus siblings.
- Operator console and README: after the Grok connector is on, ask for the task in plain language.

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
