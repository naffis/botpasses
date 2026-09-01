# HTTP API reference (internal)

Canonical hosted and local HTTP routes. Public copy: [site HTTP API](../../site/src/pages/docs/reference/http-api.astro). Router: [src/hosted/http.ts](../../src/hosted/http.ts). Access: [src/hosted/http-access-routes.ts](../../src/hosted/http-access-routes.ts). Auth pages/API: [src/hosted/http-auth-routes.ts](../../src/hosted/http-auth-routes.ts). Local loopback: [src/server.ts](../../src/server.ts).

JSON bodies are capped at 128 KiB. Hosted operator mutations need a session cookie plus `X-CSRF-Token`. Invalid Bearer on public HTML is ignored (200). Invalid Bearer on `/api` and `POST /mcp` is 401.

## Principals

| Channel | How | May call |
| --- | --- | --- |
| `operator` | HttpOnly session (`__Host-bp_session` on HTTPS, `bp_session` on loopback) or `VAULT_BOOTSTRAP_TOKEN` | `/api/*` operator routes, Access, inbox, approve/revoke. `ready === false` → 403 `{ error: "mfa_required", enroll_url: "/enroll-totp" }` |
| `model` | OAuth JWT (`aud` exactly `${origin}/mcp`, `jti` required and not revoked) or `avm_…` | `POST /mcp`, `GET /mcp`, `GET /mcp/tools`, `POST /api/grants/request` |
| `trusted` | `avt_…` | `POST /runtime/resolve` only |

JWT verify also fails if the mapped client has `revoked_at` set. Cross-org ids are **404**.

## Health and discovery

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| GET | `/health` | none | `{ ok: true, product: "botpasses" }` (no fingerprint) |
| GET | `/ready` | none | 200 `{ ok: true }` or 503 |
| GET | `/.well-known/oauth-protected-resource` | none | `{ resource: "${origin}/mcp", authorization_servers: [origin] }` |
| GET | `/.well-known/oauth-authorization-server` | none | issuer, authorize, token, jwks, register, device, revoke. `code_challenge_methods_supported` is exactly `["S256"]` |
| GET | `/robots.txt` | none | Staging allows `/`. Prod disallows `/console`, auth, collect, api, mcp, oauth |
| GET | `/mcp/tools` | model or operator | `{ tools }` same as MCP `tools/list` |

## Auth HTML and JSON

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/sign-in` `/sign-up` | Our HTML. Ready session → 302 `/console`. Email verified, no TOTP → 302 `/enroll-totp` |
| GET | `/enroll-totp` | Session required. Ready → 302 `/console` |
| GET | `/consent` | Ready operator + oidc interaction. Else 302 `/sign-in` or `/enroll-totp` |
| GET | `/device` | RFC 8628 user-code page (oidc when the provider is mounted) |
| POST | `/api/auth/otp/send` | `{ email }` → `{ ok: true }` (same for unknown emails) |
| POST | `/api/auth/otp/verify` | `{ email, otp }` → Set-Cookie session. `{ ok, enroll }` |
| POST | `/api/auth/totp/start` | Session. Returns enroll material (no secret in HTML) |
| POST | `/api/auth/totp/confirm` | `{ code }` → ready session + `backup_codes` once |
| POST | `/api/auth/logout` | Clears session cookies |
| POST | `/consent` | JSON `{ uid, decision }`. CSRF required |

OTP: 8 digits, 10 minutes, 5 verify failures kill the challenge, 5 sends / email / 15 min. TOTP: RFC 6238 SHA-1, 6 digits, no replay.

## Operator vault

All require `operatorReady` unless noted.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/api/items` | `?environment=staging\|production` | `{ items }` public fields (name, last4, hosts, inject). No values |
| POST | `/api/items` | `name`, `value`, `environment`, `kind` (`secret`\|`login`), `allowed_hosts`, `inject`, optional `username`, `folder_name` | `{ item }` public |
| POST | `/api/items/:id/rotate` | `{ value }` | `{ item }` |
| DELETE | `/api/items/:id` | | `{ ok: true }` |
| POST | `/api/folders` | `{ environment, name }` | `{ folder }` |
| POST | `/api/orgs` | `{ name }` | created org (session user, TOTP not required for first create) |
| DELETE | `/api/orgs` | `{ confirm_name }` | `{ ok: true }` |
| GET | `/api/inbox` | | `{ grants, needs, agentpass }` pending |
| GET | `/api/audit` | | `{ audit }` actions, no values |
| GET | `/api/need-items/:id` | operator + same org | need metadata (not public JSON; unsigned is **404**) |
| POST | `/api/need-items/:id/fulfill` | `{ value, name?, allowed_hosts?, inject?, kind?, username? }` | `{ item, grant_status }` |

Item names: `[A-Z][A-Z0-9_]{0,127}`. Duplicate name is 409. Empty value is 400.

## Clients and grants

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/clients/model` | operator | Issues `avm_…` once. `{ client, token, mcp_url }`. Token is not listed later |
| POST | `/api/clients/trusted` | operator | Issues `avt_…` once |
| POST | `/api/clients/:id/rotate` | operator | New plaintext once. Old hash dies |
| POST | `/api/clients/:id/revoke` | operator | `revoked_at`, grants revoked, JWT `jti` denylist. Later Bearer is 401 |
| POST | `/api/grants/request` | model or operator | `{ item_name, environment?, task_description?, client_id? }`. Rate limit 30 / org / hour. Returns grant + `approval_code` |
| POST | `/api/grants/:id/approve` | operator | `{ policy, confirm_name? }`. `folder_standing` is owner + confirm |
| POST | `/api/grants/:id/revoke` | operator | Status `revoked`. Row stays listed |
| POST | `/api/grants/approve-by-code` | operator | `{ code }` 8-digit. Reuse is 409 |
| GET/POST | `/approve?token=` | operator | Magic-link approve |

Policies: `prompt` (one inject then consumed), `session` (TTL 8h), `item_standing`, `folder_standing` (owner + `confirm_name`).

## Access snapshot and ledger

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/access` | Live snapshot only: `operators`, `clients`, `grants`, `sessions`. No `events` or `audit` array. No `avm_` / `avt_` / JWT |
| GET | `/api/access/events` | Ledger newest-first, limit 200: kind, client_id, issued/expires/revoked. `jti` is hashed |
| POST | `/api/sessions/:id/revoke` | 400 `cannot_revoke_current` if it is this session |
| POST | `/api/sessions/revoke-others` | Deletes every other operator session |

## Runtime inject (trusted only)

`POST /runtime/resolve` `{ item_name, environment? }` → plaintext for the trusted process. Model Bearer is 403. This is the hosted equivalent of `vault run`.

## MCP HTTP

`POST /mcp` JSON-RPC (`http.request`, `find_items`, `list_items`, `request_grant`, `list_grants`). See [mcp.md](./mcp.md). `GET /mcp` SSE keepalive. There is no `get_secret`.

## OAuth (this origin is the AS)

Mounted when `VAULT_OIDC_PRIVATE_JWK` is set. Engine: `oidc-provider` 9. [src/hosted/oauth-as.ts](../../src/hosted/oauth-as.ts).

| Path | Role |
| --- | --- |
| `/oauth/authorize` | Authorization code + PKCE S256 |
| `/oauth/token` | JWT access token, `aud=${origin}/mcp`, 600s, refresh rotation |
| `/oauth/jwks` | Public RS256 |
| `/oauth/register` | DCR. HTTPS redirect_uris (loopback http exception). No `javascript:` / `data:` / `file:`. 20 / IP / hour |
| `/oauth/device/auth` | RFC 8628 |
| `/oauth/revoke` | RFC 7009. Marks `access_events` + audit `token_revoked` |

Do not hook `access_token.saved` for JWT issuance. Ledger write is `extraTokenClaims` (return `undefined`) plus `access_token.issued`.

## Local `vault serve` (loopback)

`GET /` is the local console. Auth: HMAC loopback Bearer on `/api/*` and `POST /mcp`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `{ ok, product }` |
| GET | `/api/secrets` | Names + last-4 |
| POST | `/api/secrets` | `{ name, value }` store |
| GET | `/api/grants` | Grant metadata |
| POST | `/api/grants/request` | Request pending grant |
| POST | `/api/grants` | Approve (`scope` once\|session) |
| POST | `/api/grants/:id/revoke` | Revoke |
| GET | `/api/audit` | Events, no values |
| POST | `/mcp` | Local MCP JSON-RPC |

No `/api/items`, OAuth, or Access panel on the local plane.

## AgentPass (dark unless `VAULT_AGENTPASS=1`)

`/agentpass/configuration`, `/agentpass/jwks`, request/approve/validate. Not the product name. See README.

## Errors operators see

| Status | When |
| --- | --- |
| 401 | Missing/invalid session or Bearer |
| 403 | CSRF, MFA, wrong channel, Origin not allowed (no ACAO) |
| 404 | Unknown or cross-org id (need, client, grant) |
| 409 | Duplicate item name, consumed approval code |
| 410 | Expired approval |
| 413 | Body over 128 KiB |
| 429 | OTP send or `request_grant` / need limiter |
