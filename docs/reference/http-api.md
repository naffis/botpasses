# HTTP API reference (internal)

Canonical hosted and local HTTP routes. Public copy: [site HTTP API](../../site/src/content/docs/reference/http-api.md). Router: [src/hosted/http.ts](../../src/hosted/http.ts). Access: [src/hosted/http-access-routes.ts](../../src/hosted/http-access-routes.ts). Auth pages/API: [src/hosted/http-auth-routes.ts](../../src/hosted/http-auth-routes.ts). Local loopback: [src/server.ts](../../src/server.ts).

JSON bodies are capped at 128 KiB. Hosted operator mutations need a session cookie plus `X-CSRF-Token`. Invalid Bearer on public HTML is ignored (200). Invalid Bearer on `/api` and `POST /mcp` `tools/call` is 401. Handshake methods (`initialize`, `ping`, `tools/list`) succeed without a Bearer so Grok does not show a connect card. A valid `avm_…` is sufficient for all MCP methods.

## Principals

| Channel | How | May call |
| --- | --- | --- |
| `operator` | HttpOnly session (`__Host-bp_session` on HTTPS, `bp_session` on loopback) or `VAULT_BOOTSTRAP_TOKEN` | `/api/*` operator routes, Access, inbox, approve/revoke. `ready === false` → 403 `{ error: "mfa_required", enroll_url: "/enroll-totp" }` (not enrolled) or `{ error: "mfa_required", verify_url: "/verify-totp" }` (enrolled, authenticator step pending) |
| `model` | OAuth JWT (`aud` exactly `${origin}/mcp`, `jti` required and not revoked) or `avm_…` | `POST /mcp`, `GET /mcp`, `GET /mcp/tools`, `POST /api/grants/request` |
| `trusted` | `avt_…` | `POST /runtime/resolve` only |

JWT verify also fails if the mapped client has `revoked_at` set. Cross-org ids are **404**.

## Health and discovery

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| GET | `/health` | none | `{ ok: true, product: "botpasses" }` (no fingerprint) |
| GET | `/ready` | none | 200 `{ ok: true }` or 503 |
| GET | `/.well-known/oauth-protected-resource` | none | `{ resource, authorization_servers, scopes_supported, bearer_methods_supported: ["header"] }`. Same JSON at `/mcp` suffix and `/mcp/.well-known/…` |
| GET | `/.well-known/oauth-authorization-server` | none | RFC 8414. Required `response_types_supported: ["code"]`. PKCE `S256` only. Same JSON at `/mcp` suffix, `/mcp/.well-known/…`, and `/.well-known/openid-configuration` |
| GET | `/robots.txt` | none | Staging allows `/`. Prod disallows `/console`, auth, collect, api, mcp, oauth. Prod lists `Sitemap: https://botpasses.com/sitemap-index.xml` |
| GET | `/llms.txt`, `/.well-known/security.txt` | none | Static from `site/dist` |
| GET | `/mcp/tools` | none (or model/operator) | `{ tools }` same as MCP `tools/list` |
| POST | `/api/items/:id/meta` | operator | Same as `POST /api/items/:id` (below). Blank `value` keeps the current secret. |
| POST | `/api/integrations/spotify/start` | operator | `{ item_name, environment?, client_id? }` → `{ authorize_url, redirect_uri }` |
| GET | `/integrations/spotify/callback` | operator cookie | Exchanges the code, stores a refresh token, redirects to `/console#vault` |

## Auth HTML and JSON

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/sign-in` `/sign-up` | One HTML template (heading chosen by route). Ready session → 302 `/console`. Email verified, no authenticator → 302 `/enroll-totp`. Enrolled but this session has not passed the authenticator step → 302 `/verify-totp` |
| GET | `/enroll-totp` | Session required. Ready → 302 `/console`. Enrolled pending session → 302 `/verify-totp`. Shows backup codes in a dedicated step after confirm (Copy, Download, Continue) |
| GET | `/verify-totp` | Sign-in authenticator step. One field (authenticator code or backup code). Anonymous → 302 `/sign-in`; not enrolled → 302 `/enroll-totp`; ready → 302 `/console` |
| GET | `/consent` | Ready operator + oidc interaction. Else 302 `/sign-in` or `/enroll-totp` |
| GET | `/device` | RFC 8628 user-code page (oidc when the provider is mounted) |
| POST | `/api/auth/otp/send` | `{ email }` → `{ ok: true, message }` (identical for unknown emails). A still-valid unused code is not emailed again. Per-IP limit reads `Fly-Client-IP`, then the last `X-Forwarded-For` hop |
| POST | `/api/auth/otp/verify` | `{ email, otp }` → Set-Cookie session with `mfa_at` null. `{ ok, enroll, verify }`. 401 carries `attempts_remaining` |
| POST | `/api/auth/totp/start` | Session + CSRF. Returns `{ otpauth_url, qr_svg }`. QR is local SVG. Re-enroll (already enrolled) needs a ready session and `{ current_code }` (403 `current_code_required`). Pending secret is stored wrapped, so enrollment survives a restart |
| POST | `/api/auth/totp/confirm` | `{ code }` + CSRF. Enrollment only. Rotates the session (`mfa_at` set), deletes other pre-MFA sessions and unused backup codes, returns `backup_codes` once. 429 `{ retry_after }` while locked |
| POST | `/api/auth/totp/verify` | `{ code }` + CSRF. Sign-in authenticator step: authenticator or backup code. Rotates the session with `mfa_at` set. 10 failures lock for 15 minutes (429 `{ retry_after }`) |
| GET | `/api/auth/me` | Ready session. `{ email, totp_enabled, backup_codes_remaining, created_at }` |
| POST | `/api/auth/backup-codes/regenerate` | `{ code }` + CSRF. Replaces every unused backup code. `{ backup_codes }` once |
| POST | `/api/auth/logout` | CSRF for cookie sessions. Clears session cookies and ends the OAuth server's own session |
| POST | `/consent` | JSON `{ uid, decision }`. CSRF required |

OTP: 8 digits, 10 minutes, 5 verify failures kill the challenge, 5 sends / email / 15 min, 10 sends / IP / 15 min. TOTP: RFC 6238 SHA-1, 6 digits, no replay, 10 failures lock 15 minutes. TOTP secrets are wrapped under an identity DEK (itself wrapped by the KEK, re-wrapped on `vault kek-rotate`). Sessions issued by the email step are not `ready` until `totp/verify` or `totp/confirm` sets `mfa_at`.

## Operator vault

All require `operatorReady` unless noted.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/api/items` | omit `environment` for every env this deploy plane serves; or `?environment=staging\|production` | `{ items }` public fields (name, last4, hosts, inject). No values. Staging deploy: `environment=production` is 404 |
| POST | `/api/items` | `name`, `value`, `environment`, `kind` (`secret`\|`client_secret`\|`login`), `allowed_hosts`, `inject`, optional `username`, `folder_name`. Omit `inject` to use the Kind default (Bearer or client_credentials). | `{ item }` public |
| POST | `/api/items/:id` | Same fields as store. `value` optional; blank keeps the current secret. | `{ item }` public |
| POST | `/api/items/:id/rotate` | `{ value }` | `{ item }` |
| DELETE | `/api/items/:id` | | `{ ok: true }` |
| POST | `/api/folders` | `{ environment, name }` | `{ folder }` |
| POST | `/api/orgs` | `{ name }` | created org (session user, TOTP not required for first create) |
| DELETE | `/api/orgs` | `{ confirm_name }` | `{ ok: true }` |
| GET | `/api/inbox` | | `{ grants, needs, agentpass }` pending |
| GET | `/api/audit` | optional `?client_id=` and `?item_name=` | `{ audit }` actions and item names, no values |
| GET | `/api/need-items/:id` | operator + same org | need metadata (not public JSON; unsigned is **404**) |
| POST | `/api/need-items/:id/fulfill` | `{ value, name?, allowed_hosts?, inject?, kind?, username? }` | `{ item, grant_status }` |

Item names: `[A-Z][A-Z0-9_]{0,127}`. Duplicate name is 409. Empty value is 400.

## Clients and grants

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/clients/model` | operator | Issues `avm_…` once. `{ client, token, mcp_url }`. Token is not listed later |
| POST | `/api/clients/trusted` | operator | Issues `avt_…` once |
| POST | `/api/clients/:id/rotate` | operator | New plaintext once. Old hash dies |
| POST | `/api/clients/:id/revoke` | operator | `revoked_at`, grants revoked, JWT `jti` denylist. Later Bearer is 401. A later OAuth re-consent reactivates the same row (the `(org_id, oauth_client_id)` pair is unique) |
| POST | `/api/grants/request` | model or operator | `{ item_name, task_description?, client_id?, operator_email? }`. `operator_email` is ignored for model principals; an operator may pass a member's email (400 otherwise); with none given every verified member is emailed. Optional `host`, `method`, `path` (the call the agent will make; see MCP `request_grant`). Returns the existing open grant for the client and item (a pending one gets a fresh `approval_code`). Rate limit 30 / org / hour inside the kernel, shared with `http_request` and new needs |
| POST | `/api/grants/:id/approve` | operator | `{ policy, confirm_name?, scope? }`. `scope: { methods?, path_prefixes?, hosts?, max_calls?, ttl_seconds? }`; omit to inherit the requested call (or no limits); present dimensions are used exactly; `hosts` must be a subset of the item's hosts (400). `ttl_seconds` 60..86400 for `session` (default 28800), 60..31536000 for standing policies, which then expire. `folder_standing` is owner + confirm |
| POST | `/api/grants/:id/revoke` | operator | Status `revoked`. Row stays listed |
| POST | `/api/grants/approve-by-code` | operator | `{ code }` 8-digit. Reuse is 409 |
| GET | `/approve?token=` | none | Renders an HTML confirm page (client, item, last-4, policy). No state change |
| POST | `/approve` | none | `{ token }` JSON or form body. Re-verifies the HMAC token and approves. Exempt from `X-CSRF-Token` (the token is the CSRF defence) |
| POST | `/api/clients/:id/environment` | operator | `{ environment }`. Moves an agent (including OAuth-issued ones) to another vault environment. 409 if revoked |
| HEAD | `/console` | none | Same headers as GET |

Policies: `prompt` (one **successful** origin inject then consumed; 4xx/5xx reactivates so the agent can retry), `session` (TTL 8h), `item_standing`, `folder_standing` (owner + `confirm_name`). DCR `redirect_uris` may be https, loopback http, or a desktop app scheme (`cursor://`, `grok://`).

## Access snapshot and ledger

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/access` | Live snapshot only: `operators`, `clients`, `grants`, `sessions`. Clients and grants include `created_at`, `first_access_at`, `last_access_at`, and `fetched` (item names). Clients include `last4` of the machine bearer when issued. No `events` or `audit` array. No `avm_` / `avt_` / JWT |
| GET | `/api/access/events` | Ledger newest-first, limit 200: kind, client_id, issued/expires/revoked. `jti` is hashed |
| POST | `/api/sessions/:id/revoke` | `:id` is the 12-character prefix shown in Access (shorter or ambiguous is 400). Owners may revoke another member's session; operators only their own others (403). 400 `cannot_revoke_current` if it is this session |
| POST | `/api/sessions/revoke-others` | Deletes every other operator session |

## Runtime inject (trusted only)

`POST /runtime/resolve` `{ item_name, environment? }` → plaintext for the trusted process. Model Bearer is 403. This is the hosted equivalent of `vault run`.

## MCP HTTP

`POST /mcp` JSON-RPC (`http_request`, `find_items`, `list_items`, `request_grant`, `list_grants`; `http.request` is an alias for one release). See [mcp.md](./mcp.md). `GET /mcp` is an SSE keepalive stream (auth optional for the stream). `GET /mcp/tools` returns the tool list. There is no `get_secret`.

## OAuth (botpasses.com is the AS)

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

## Static site

`site/dist` (Astro) is served by [src/hosted/static-site.ts](../../src/hosted/static-site.ts) for `/`, `/design`, `/security`, `/privacy`, `/terms`, `/changelog`, `/docs/**`, `/_astro/**`, `/pagefind/**`, `/sitemap-*.xml`, `/favicon.svg`, `/og.png`, `/llms.txt`, and `/.well-known/security.txt`. `*.html` and trailing-slash forms 308 to the canonical URL (`/console/` is handled by the router, not here). Unknown paths under those prefixes return the Astro `404.html` with status 404. HTML is `no-cache` from the static layer (the router's `no-store` wins today), `_astro/*` is `public, max-age=31536000, immutable`, other assets `public, max-age=3600`.

## Errors operators see

Inbox grant cards (`GET /api/inbox`) carry `requested_scope`, `grant_scope`, `allowed_hosts`, `expires_at`; `GET /api/access` grants carry `policy`, `expires_at`, `grant_scope`. Audit actions: `scope_denied`, `grant_exhausted`, `client_environment`, `client_reactivated`, `inject_denied`, `inject_failed`.

Unexpected failures are `500 { error: "Internal error", request_id }` with an `x-request-id` header; the detail is in the server log under `request_error`, never in the response. Malformed JSON bodies are `400 { error: "Invalid JSON" }`. Every response carries `x-request-id`.

| Status | When |
| --- | --- |
| 401 | Missing/invalid session or Bearer |
| 403 | CSRF, MFA, wrong channel, foreign Origin on `/api` (no ACAO). `/mcp` and `/oauth` reflect a foreign Origin. |
| 404 | Unknown or cross-org id (need, client, grant) |
| 409 | Duplicate item name, consumed approval code |
| 410 | Expired approval |
| 413 | Body over 128 KiB |
| 429 | OTP send or `request_grant` / need limiter |
