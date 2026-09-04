# HTTP API reference (internal)

Canonical hosted and local HTTP routes. Public copy: [site HTTP API](../../site/src/content/docs/reference/http-api.md). Router: [src/hosted/http.ts](../../src/hosted/http.ts). Access: [src/hosted/http-access-routes.ts](../../src/hosted/http-access-routes.ts). Auth pages/API: [src/hosted/http-auth-routes.ts](../../src/hosted/http-auth-routes.ts). Local loopback: [src/server.ts](../../src/server.ts).

JSON bodies are capped at 128 KiB and must be sent as `Content-Type: application/json` (any other type is `415 { error: "Content-Type must be application/json" }`; a POST with no body and no type reads as `{}`). Only `POST /approve` and `POST /consent`, which back HTML forms, also accept `application/x-www-form-urlencoded`. Hosted operator mutations need a session cookie plus `X-CSRF-Token`. Invalid Bearer on public HTML is ignored (200). Invalid Bearer on `/api` and `POST /mcp` `tools/call` is 401. Handshake methods (`initialize`, `ping`, `tools/list`) succeed without a Bearer so Grok does not show a connect card. A valid `avm_…` is sufficient for all MCP methods.

## Principals

| Channel | How | May call |
| --- | --- | --- |
| `operator` | HttpOnly session (`__Host-bp_session` on HTTPS, read only on a request the proxy marks `x-forwarded-proto: https`, no plain-name fallback; `bp_session` on loopback) or `VAULT_BOOTSTRAP_TOKEN` (on a plane only with `VAULT_BOOTSTRAP_ALLOW_PLANE=1`; every use logs `auth_bootstrap_used`) | `/api/*` operator routes, Access, inbox, approve/revoke. `ready === false` → 403 `{ error: "mfa_required", enroll_url: "/enroll-totp" }` (not enrolled) or `{ error: "mfa_required", verify_url: "/verify-totp" }` (enrolled, authenticator step pending) |
| `model` | OAuth JWT (`aud` exactly `${origin}/mcp`, `jti` required and not revoked, `org_id` required and `sub` a member of it) or `avm_…` | `POST /mcp`, `GET /mcp`, `GET /mcp/tools`, `POST /api/grants/request` |
| `trusted` | `avt_…` | `POST /runtime/resolve` only |

JWT verify allows 30 s of clock skew, accepts any key in `/oauth/jwks` (current or the one being rotated out), maps `(org_id, client_id)` to the vault client, and fails if that client has `revoked_at` set. It never provisions an org. Cross-org ids are **404**.

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
| POST | `/api/integrations/:provider/start` | operator | `:provider` is a registry id with a user connect flow (`spotify`, `github`, `google`, `slack`, `stripe`; unknown is 404). `{ item_name, environment?, client_id?, redirect_uri?, agent_client_id? }` → `{ authorize_url, redirect_uri, provider }`. `client_id` defaults to the item username. `agent_client_id` names the one model client that gets an `item_standing` policy on the refresh item after connect; without it the operator approves normally. The sealed `state` carries the provider id. |
| GET | `/integrations/:provider/callback` | operator cookie (ready) | Exchanges the code with the client-secret item, stores the refresh token as `<ITEM>_REFRESH` (`inject: refresh`, allowed on the provider API and token hosts), redirects to `/console#vault?connected=<provider>` or `?connect_error=<provider>&reason=<code>` where `reason` is `state_expired` (invalid, expired, or foreign state), `provider_denied` (the provider sent `error`), `exchange_failed` (non-2xx code exchange), or `no_refresh_token`. A state minted for another provider, another org, or another operator account is refused. An existing `<ITEM>_REFRESH` is rotated and its hosts and inject mode reset to the provider defaults. Audit: `provider_connected`, plus `grant` when `agent_client_id` was given. `/api/integrations/spotify/start` and `/integrations/spotify/callback` are these routes with `:provider = spotify`. |

## Auth HTML and JSON

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/sign-in` `/sign-up` | One HTML template (heading chosen by route). Ready session → 302 `/console`. Email verified, no authenticator → 302 `/enroll-totp`. Enrolled but this session has not passed the authenticator step → 302 `/verify-totp` |
| GET | `/enroll-totp` | Session required. Ready → 302 `/console`, unless a re-enroll secret is in flight (a `totp/start` with the current code, live for 10 minutes): then the page renders and shows that secret. Enrolled pending session → 302 `/verify-totp`. Shows backup codes in a dedicated step after confirm (Copy, Download, Continue) |
| GET | `/verify-totp` | Sign-in authenticator step. One field (authenticator code or backup code). Anonymous → 302 `/sign-in`; not enrolled → 302 `/enroll-totp`; ready → 302 `/console` |
| GET | `/consent` | Ready operator + oidc interaction. Else 302 `/sign-in` or `/enroll-totp`. Only mounted with the OAuth provider (404 otherwise) |
| GET | `/device` | RFC 8628 user-code page, served by the OAuth provider. Only mounted with the provider (404 otherwise) |
| POST | `/api/auth/otp/send` | `{ email }` → `{ ok: true, message }` (identical for unknown emails). The code is emailed before the challenge is stored (503 and no challenge when delivery fails). A resend replaces a still-valid code: the old one stops working and the send counts against the budget. Per-IP limit reads `Fly-Client-IP`, then the last `X-Forwarded-For` hop, only behind Fly or with `VAULT_TRUST_PROXY=1`; otherwise the socket peer |
| POST | `/api/auth/otp/verify` | `{ email, otp }` → Set-Cookie session with `mfa_at` null. `{ ok, enroll, verify }`. 401 carries `attempts_remaining`. Attempts are claimed atomically in the store; 25 verifies per email and 50 per address in 15 minutes (429) |
| POST | `/api/auth/totp/start` | Session + CSRF. Returns `{ otpauth_url, qr_svg }`. QR is local SVG. Re-enroll (already enrolled) needs a ready session and `{ current_code }` (403 `current_code_required`). Pending secret is stored wrapped, so enrollment survives a restart |
| GET | `/api/auth/totp/pending` | Session. The enrollment in flight, `{ otpauth_url, qr_svg }` exactly as `start` returned it, while it is live (10 minutes); 404 `no_pending_enrollment` otherwise. An enrolled account needs a session that passed the authenticator step (403 `mfa_required`). The enroll page reads this first and calls `start` only when nothing is pending, so a reload or the console's re-enroll shows the secret `confirm` will check |
| POST | `/api/auth/totp/confirm` | `{ code }` + CSRF. Enrollment only. Rotates the session (`mfa_at` set), deletes other pre-MFA sessions and unused backup codes, returns `backup_codes` once. 429 `{ retry_after }` while locked |
| POST | `/api/auth/totp/verify` | `{ code }` + CSRF. Sign-in authenticator step: authenticator or backup code. Rotates the session with `mfa_at` set. 10 failures lock for 15 minutes (429 `{ retry_after }`) |
| GET | `/api/auth/me` | Ready session. `{ email, totp_enabled, backup_codes_remaining, created_at }` |
| POST | `/api/auth/backup-codes/regenerate` | `{ code }` + CSRF. Replaces every unused backup code. `{ backup_codes }` once |
| POST | `/api/auth/logout` | CSRF for cookie sessions. Clears session cookies and ends the OAuth server's own session |
| POST | `/consent` | JSON `{ uid, decision }` (a form body is accepted too). `X-CSRF-Token` required like every cookie-session mutation; the consent form carries no CSRF field, so a submit without the header (scripts off) is 403 and the interaction stays open. With `Accept: application/json` (the page's script) the answer is `200 { location }` and the page navigates to that resume URL itself, because a script cannot read a redirect's Location; a caller with the header and no such `Accept` gets a 303 to the same URL. Only `decision: "allow"` grants |

OTP: 8 digits, 10 minutes, 5 verify failures kill the challenge, 5 sends / email / 15 min, 10 sends / IP / 15 min. TOTP: RFC 6238 SHA-1, 6 digits, no replay, 10 failures lock 15 minutes; the attempt is charged, the step consumed, and a backup code marked used with conditional updates, so a code passes once even under concurrent submission. Cookies: `Max-Age` is the 7-day absolute lifetime; the server-side 12-hour idle expiry (extended on every request) is authoritative. The CSRF token (`bp_csrf` / `__Host-bp_csrf`, sent back as `X-CSRF-Token`) is signed for the session cookie it accompanies. TOTP secrets are wrapped under an identity DEK (itself wrapped by the KEK, re-wrapped on `vault kek-rotate`). Sessions issued by the email step are not `ready` until `totp/verify` or `totp/confirm` sets `mfa_at`.

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
| POST | `/api/orgs` | `{ name }` (1 to 80 printable characters, trimmed; 400 otherwise) | `{ orgId }`. Ready session required (403 `mfa_required` before the authenticator step). 402 `plan_limit` kind `orgs` past the per-user limit (10 owned orgs on the free tier) |
| DELETE | `/api/orgs` | `{ confirm_name }` | `{ ok: true }` |
| GET | `/api/inbox` | | `{ grants, needs }` pending |
| GET | `/api/audit` | optional `?client_id=` and `?item_name=` | `{ audit }` actions and item names, no values |
| GET | `/api/need-items/:id` | operator + same org | need metadata (not public JSON; unsigned or another org's need is **404**, never 403) |
| POST | `/api/need-items/:id/fulfill` | `{ value, name?, allowed_hosts?, inject?, kind?, username? }` | `{ item, grant_status }` |

Item names: `[A-Z][A-Z0-9_]{0,127}`. Duplicate name is 409. Empty value is 400.

## Clients and grants

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/clients/model` | operator | Issues `avm_…` once. `{ client, token, mcp_url }`. Token is not listed later |
| POST | `/api/clients/trusted` | operator | Issues `avt_…` once |
| POST | `/api/clients/:id/rotate` | operator | New plaintext once. Old hash dies. 409 if revoked |
| POST | `/api/clients/:id/revoke` | operator | `revoked_at`, grants revoked, JWT `jti` denylist, and every OAuth grant the org's members gave for that client id is destroyed (refresh tokens included); the same person's grants for that client id in other orgs survive. Later Bearer is 401; a refresh is `invalid_grant`. Only a fresh consent (authorization code or device code) reactivates the same row (the `(org_id, oauth_client_id)` pair is unique); a refresh never does |
| POST | `/api/grants/request` | model or operator | `{ item_name, task_description?, client_id?, operator_email? }`. `operator_email` is ignored for model principals; an operator may pass a member's email (400 otherwise); with none given every verified member is emailed. Optional `host`, `method`, `path` (the call the agent will make; see MCP `request_grant`). Returns the existing open grant for the client and item (a pending one gets a fresh `approval_code`). Rate limit 30 / org / hour inside the kernel, shared with `http_request` and new needs |
| POST | `/api/grants/:id/approve` | operator | `{ policy, confirm_name?, scope? }`. `scope: { methods?, path_prefixes?, hosts?, max_calls?, ttl_seconds? }`; omit to inherit the requested call (or no limits); present dimensions are used exactly; `hosts` must be a subset of the item's hosts (400). `ttl_seconds` 60..86400 for `session` (default 28800), 60..31536000 for standing policies, which then expire. `folder_standing` is owner + confirm. A grant for a trusted (`avt_`) client refuses `methods`, `path_prefixes`, and `hosts`, explicit or inherited from the request, with 400 `scope_unenforceable`: the runtime resolves the value directly and nothing checks those limits. Approve it with `scope: {}` or with `max_calls` / `ttl_seconds`, which are counted on resolve. A standing approval replaces a stale policy row for the same pair |
| POST | `/api/grants/:id/revoke` | operator | Status `revoked`, plus every other open grant for the same (client, item) pair. Drops the `item_standing` policy for the pair. Drops the `folder_standing` policy only when this grant was activated by it (`policy: folder_standing`), which ends the folder approval for every item it covers; revoking a `prompt`, `session`, or `item_standing` grant leaves a folder-wide approval in place. Row stays listed for 30 days after it settles, then the sweep removes it (audit rows stay) |
| POST | `/api/grants/approve-by-code` | operator | `{ code }` 8-digit. Reuse is 409. Five wrong codes lock that grant's code (the count survives the agent re-requesting and the code rotating; approve from the inbox instead). 20 attempts per org per 15 minutes, then 429 |
| GET | `/approve?token=` | none | Renders an HTML confirm page (client, item, last-4, policy). No state change. Signed out: 302 `/sign-in`. Signed in but not past the authenticator step: 302 `/verify-totp` (enrolled) or `/enroll-totp` |
| POST | `/approve` | none | `{ token }` JSON or form body. Re-verifies the HMAC token and approves. Exempt from `X-CSRF-Token` (the token is the CSRF defence) |
| POST | `/api/clients/:id/environment` | operator | `{ environment }`. Moves an agent (including OAuth-issued ones) to another vault environment. 409 if revoked |
| HEAD | `/console` | none | Same headers as GET |

Policies: `prompt` (one call: spent by any origin answer or any failure after the credential left the process; handed back only when the send never left, such as a host mismatch or a DNS, connect, or TLS failure), `session` (TTL 8h), `item_standing`, `folder_standing` (owner + `confirm_name`). Operators who expect retries approve with `max_calls` or `session`. DCR `redirect_uris` may be https, loopback http, or a desktop app scheme (`cursor://`, `grok://`).

## Access snapshot and ledger

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/access` | Live snapshot only: `operators`, `clients`, `grants`, `sessions`. Clients and grants include `created_at`, `first_access_at`, `last_access_at`, and `fetched` (item names). Clients include `last4` of the machine bearer when issued. No `events` or `audit` array. No `avm_` / `avt_` / JWT |
| GET | `/api/access/events` | Ledger newest-first, limit 200: kind, client_id, issued/expires/revoked. `jti` is hashed |
| POST | `/api/sessions/:id/revoke` | `:id` is the 12-character prefix shown in Access (shorter or ambiguous is 400). Only sessions acting in the caller's org are listed and revocable: a session's org is its pinned `active_org_id` while the user is still a member, else the user's first membership (404 otherwise). Owners may revoke another member's session; operators only their own others (403). 400 `cannot_revoke_current` if it is this session. Logs `auth_session_revoked` |
| POST | `/api/sessions/revoke-others` | Deletes every other operator session |

## Runtime inject (trusted only)

`POST /runtime/resolve` `{ item_name, environment? }` → plaintext for the trusted process. Model Bearer is 403. This is the hosted equivalent of `vault run`.

## MCP HTTP

`POST /mcp` JSON-RPC (`http_request`, `find_items`, `list_items`, `request_grant`, `list_grants`; `http.request` is an alias for one release). See [mcp.md](./mcp.md). `GET /mcp` is an SSE keepalive stream and requires a model or operator principal (401 otherwise). `GET /mcp/tools` returns the tool list. There is no `get_secret`.

## OAuth (botpasses.com is the AS)

Mounted when `VAULT_OIDC_PRIVATE_JWK` is set. Engine: `oidc-provider` 9. [src/hosted/oauth-as.ts](../../src/hosted/oauth-as.ts). The engine is pinned to the constants in [oauth-metadata.ts](../../src/hosted/oauth-metadata.ts) that also build the discovery document: scopes `openid mcp`, response type `code`, response modes `query`, `fragment`, `form_post`, grant types `authorization_code`, `refresh_token`, device code, token endpoint auth `none` only (a registration asking for a client secret is `invalid_client_metadata`), PKCE `S256`, DPoP off.

| Path | Role |
| --- | --- |
| `/oauth/authorize` | Authorization code + PKCE S256. Consent binds the operator session's org into the grant |
| `/oauth/token` | JWT access token, `aud=${origin}/mcp`, 600s, claim `org_id`, refresh rotation. A refresh for a revoked vault client is `invalid_grant` and never reactivates it |
| `/oauth/jwks` | Public RS256. Two keys while `VAULT_OIDC_PREVIOUS_JWK` is set; tokens are signed with the current one ([rotation](../ops/oidc-key-rotation.md)) |
| `/oauth/register` | DCR. HTTPS redirect_uris (loopback http exception). No `javascript:` / `data:` / `file:`. 20 / IP / hour |
| `/oauth/device/auth` | RFC 8628. `POST /device` user-code attempts: 10 / 15 min per IP and per OP session |
| `/oauth/revoke` | RFC 7009. A refresh token revokes its grant and marks every ledger row issued under it (`access_events.grant_id`); a JWT access token that verifies and belongs to the calling client is denylisted by `jti`. Audit `token_revoked`. Unknown tokens are 200 |

Client ID Metadata Documents (`client_id` is an https URL): fetched through the SSRF-pinned fetch, 30 / host / hour, 10 / requesting IP / hour, at most 4 in flight, 3 s timeout, cached 60 s to 1 h.

Do not hook `access_token.saved` for JWT issuance. Ledger write is `extraTokenClaims` (return the `org_id` claim; throw fails the grant) plus `access_token.issued`; refresh tokens via `refresh_token.saved`. Grant-wide ledger revocation runs in the revocation post-hook and on `grant.revoked` (refresh reuse).

## Local `vault serve` (loopback)

`GET /` is the local console. Auth: two HMAC loopback Bearers printed by `vault serve`. The operator bearer opens `/api/*` (and is what the console stores); the model bearer opens `POST /mcp` (and is what `vault mcp --remote` sends). Each is refused on the other surface (401). The server answers only to a loopback `Host` (403 otherwise), reads at most 128 KiB of JSON body (413), and answers malformed JSON with `400 Invalid JSON` without echoing the bytes. Unexpected failures are `500 { error: "Internal error" }`; only the vault's own validation messages reach the client.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `{ ok, product }` |
| GET | `/api/secrets` | `{ secrets }`: name, last-4, hosts, inject, username. No values |
| GET | `/api/items` | The same list as `{ items }` (hosted key) |
| POST | `/api/secrets` | `{ name, value, allowed_hosts?, inject? }` store; answers `{ secret }` |
| POST | `/api/items` | The same store; answers `{ item }` |
| GET | `/api/grants` | Grant metadata |
| POST | `/api/grants/request` | Request pending grant |
| POST | `/api/grants` | Approve (`scope` once\|session) |
| POST | `/api/grants/:id/revoke` | Revoke |
| GET | `/api/audit` | Events, no values |
| POST | `/mcp` | Local MCP JSON-RPC |

No OAuth, provider connect, `/api/items/:id` edit or rotate routes, or Access panel on the local plane; `/api/items` only lists and stores (router: `src/server.ts`).

## Static site

`site/dist` (Astro) is served by [src/hosted/static-site.ts](../../src/hosted/static-site.ts) for `/`, `/design`, `/security`, `/privacy`, `/terms`, `/changelog`, `/docs/**`, `/_astro/**`, `/pagefind/**`, `/sitemap-*.xml`, `/favicon.svg`, `/og.png`, `/llms.txt`, and `/.well-known/security.txt`. `*.html` and trailing-slash forms 308 to the canonical URL (`/console/` is handled by the router, not here). Unknown paths under those prefixes return the Astro `404.html` with status 404. HTML is `no-cache` from the static layer (the router's `no-store` wins today), `_astro/*` is `public, max-age=31536000, immutable`, other assets `public, max-age=3600`. The site, like every page, is served only when the `Host` header is the public origin (`403 { error: "Origin/Host not allowed" }` otherwise); `/health`, `/ready`, discovery, and `/assets/*` answer on any Host for platform checks.

First-party assets (`console.js`, `console.css`, `auth.js`, `auth.css`, `collect.js`, `mark.svg`) are referenced by the pages at content-hashed paths, `/assets/console.<sha8>.js`, and served `public, max-age=31536000, immutable`; the hash changes with the body, so a deploy never fights a cached bundle. The plain names still resolve to the current body but are `no-cache`.


## Team, org switcher, plan

Owner-only mutations; every member may read. All need a ready session plus `X-CSRF-Token`.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/api/members` | | `{ members: [{ user_id, email, role, joined_at }], invites: [{ id, email, role, created_at, expires_at, expired }] }` |
| POST | `/api/members/invite` | `{ email, role }` | `{ invite, accept_url }` (link also emailed when Resend is configured; 7-day expiry; 409 for a pending invite or existing member; 402 `plan_limit` kind `members`; 429 past 10 invites per inviting account or 30 per address in an hour) |
| POST | `/api/members/:userId/role` | `{ role }` | The last owner cannot be demoted (400) |
| DELETE | `/api/members/:userId` | | The last owner cannot be removed (400) |
| DELETE | `/api/invites/:id` | | Cancels a pending invite |
| GET | `/accept-invite?token=` | | HTML: sign in first if needed; wrong account offers sign-out; accept form posts with CSRF |
| POST | `/api/invites/accept` | `{ token }` | Joins the caller (email must match; 403 `invite_email_mismatch`; 404 bad token; 410 used or expired) and pins the joined org on the session |
| GET | `/api/orgs` | | Orgs the caller belongs to, with roles |
| POST | `/api/session/org` | `{ org_id }` | Pins the active org on this session (membership checked) |
| GET | `/api/plan` | | `{ limits, usage }` for credentials, agents, members, calls (this UTC month); `limits` also carries the per-user `orgs` cap, which has no per-org usage |

Plan limits: free tier is 25 credentials, 10 agents, 3 members, 5000 `http_request` calls per month; `VAULT_PLAN_LIMITS_JSON` overrides. Exceeding one is `402 { error: "plan_limit", kind, limit }`. Audit actions: `member_invited`, `member_joined`, `member_removed`, `member_role`.

## Errors operators see

Inbox grant cards (`GET /api/inbox`) carry `requested_scope`, `grant_scope`, `allowed_hosts`, `expires_at`; `GET /api/access` grants carry `policy`, `expires_at`, `grant_scope`. Audit actions: `scope_denied`, `grant_exhausted`, `client_environment`, `client_reactivated`, `inject_denied`, `inject_failed`, `refresh_rotated` (a provider rotated an `<ITEM>_REFRESH` value; actor `provider`), `dek_rewrapped` (actor `system`; an org DEK moved from the previous KEK to the current one during a rotation). `allowed_hosts` are stored trimmed, lowercase, and deduplicated on create and update.

Unexpected failures are `500 { error: "Internal error", request_id }` with an `x-request-id` header; the detail is in the server log under `request_error`, never in the response. Malformed JSON bodies are `400 { error: "Invalid JSON" }`. Every response carries `x-request-id`.

| Status | When |
| --- | --- |
| 401 | Missing/invalid session or Bearer |
| 403 | CSRF, MFA, wrong channel, foreign Origin on `/api` (no ACAO). `/mcp` and `/oauth` reflect a foreign Origin. |
| 404 | Unknown or cross-org id (need, client, grant) |
| 409 | Duplicate item name, consumed approval code |
| 410 | Expired approval |
| 413 | Body over 128 KiB |
| 415 | A JSON route was sent a body that is not `application/json` |
| 429 | OTP send, `request_grant` / need limiter, DCR, or `POST /device` attempts |
