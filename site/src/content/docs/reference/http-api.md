---
title: HTTP API
description: Every hosted route on botpasses.com. Operator JSON under /api, model routes, trusted resolve, OAuth endpoints, discovery, and the local vault serve API.
section: reference
order: 2
---

Hosted JSON lives under `/api`. MCP is `POST /mcp` (see [MCP tools](/docs/reference/mcp-tools)). OAuth is `/oauth/*` on botpasses.com, which is its own authorization server. Local `npx vault serve` is a smaller loopback API, listed at the end.

Operator JSON never includes secret values after submit. Model tokens cannot resolve a value. Trusted tokens cannot call MCP. JSON bodies must be sent as `Content-Type: application/json` (anything else is 415); bodies over 128 KiB are 413.

## Who may call what

| Who | Credential | May call |
| --- | --- | --- |
| Operator | HttpOnly session cookie after email code and authenticator. Send `X-CSRF-Token` on POST and DELETE | `/api/*` operator routes, Inbox, Access, approve, revoke |
| Model (agent) | OAuth access JWT (`aud` is `https://botpasses.com/mcp`; its `org_id` is the organisation the operator consented in, and the operator must still be a member) or a console-issued `avm_...` bearer | `POST /mcp`, `GET /mcp`, `GET /mcp/tools`, `POST /api/grants/request` |
| Trusted runtime | `avt_...` bearer | `POST /runtime/resolve` only |

A session that has not completed the authenticator step gets 403 `{ "error": "mfa_required", "enroll_url": "/enroll-totp" }` when no authenticator is enrolled, or `{ "error": "mfa_required", "verify_url": "/verify-totp" }` when one is and this session has not passed it yet. Ids from another organisation are 404. A foreign browser `Origin` on `/api` is 403 with no CORS allow header; `/mcp`, the well-known documents, and `/oauth` reflect the caller's Origin so browser-based MCP hosts can connect. Invalid bearer on public HTML is ignored (the page loads); the same bearer on `/api` or `POST /mcp` is 401.

## Health and discovery

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `{ "ok": true, "product": "botpasses" }`. No key fingerprint |
| GET | `/ready` | 200 or 503 from the database ping |
| GET | `/.well-known/oauth-protected-resource` | `resource` is `https://botpasses.com/mcp`. Same document at the `/mcp` path-aware URLs |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414. `response_types_supported` is `["code"]`, PKCE `S256` only. Also at `/.well-known/openid-configuration` |
| GET | `/robots.txt` | Production disallows console, auth, collect, api, mcp, oauth |
| GET | `/.well-known/security.txt` | Vulnerability contact. See [Security disclosure](/docs/security/disclosure) |

## Sign-in and account

| Method | Path | Body |
| --- | --- | --- |
| GET | `/sign-in`, `/sign-up` | HTML. A ready session redirects to `/console`; a verified email without an authenticator redirects to `/enroll-totp`; an enrolled account that has not passed the authenticator step this session redirects to `/verify-totp` |
| GET | `/enroll-totp` | HTML. Session required. Shows backup codes once after confirm. A ready session that started a re-enroll from the console lands here and sees the pending QR |
| GET | `/verify-totp` | HTML. The sign-in authenticator step: one field for an authenticator code or a backup code |
| POST | `/api/auth/otp/send` | `{ "email" }`. Returns `{ "ok": true }` for known and unknown emails. Sending again replaces the previous code; five sends per email in 15 minutes |
| POST | `/api/auth/otp/verify` | `{ "email", "otp" }`. Sets a pending session cookie. Returns `{ "ok", "enroll", "verify" }`: `enroll` means go to `/enroll-totp`, `verify` means go to `/verify-totp`. A 401 carries `attempts_remaining` |
| POST | `/api/auth/totp/start` | Begin authenticator enrollment. Returns `otpauth_url` and a locally rendered `qr_svg`. Re-enrolling needs a ready session and `{ "current_code" }` |
| GET | `/api/auth/totp/pending` | The enrollment in flight (`otpauth_url`, `qr_svg`) while it is live, 10 minutes from `start`; 404 `no_pending_enrollment` otherwise. The enroll page reads this before calling `start`, so a reload or a re-enroll shows the secret that `confirm` will check |
| POST | `/api/auth/totp/confirm` | `{ "code" }`. Marks the session ready and returns backup codes once |
| POST | `/api/auth/totp/verify` | `{ "code" }`. The sign-in authenticator step: an authenticator code or an unused backup code. Marks the session ready. Ten failures lock the account for 15 minutes (429 with `retry_after`) |
| GET | `/api/auth/me` | `{ "email", "totp_enabled", "backup_codes_remaining", "created_at" }` |
| POST | `/api/auth/backup-codes/regenerate` | `{ "code" }`. Replaces every unused backup code and returns the new set once |
| POST | `/api/auth/logout` | Clears the session cookies and ends the OAuth sign-in session. Needs `X-CSRF-Token` |
| POST | `/api/orgs` | `{ "name" }` (1 to 80 characters). Creates an organisation for the signed-in user after the authenticator step; up to ten owned organisations per account (402 `plan_limit`) |
| DELETE | `/api/orgs` | `{ "confirm_name" }`. Deletes the organisation and everything in it |

Email codes are 8 digits, valid 10 minutes, single use; five wrong attempts end the challenge. Authenticator codes are RFC 6238 (SHA-1, 6 digits) with replay protection. Authenticator secrets are encrypted under a key that `vault kek-rotate` re-wraps.

## Items and collect

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/items` | Names, last-4, hosts, inject. No values. Omit `environment` for every environment this plane serves. On staging, `environment=production` is 404 |
| POST | `/api/items` | `name`, `value`, `environment`, `kind` (`secret`, `client_secret`, `login`), `allowed_hosts`, `inject` (`bearer`, `client_credentials`, `basic`, `header:Name`), optional `username`, `folder_name`. A `client_secret` needs the client ID in `username` |
| POST | `/api/items/:id` | Edit name, kind, environment, hosts, client ID, inject. `value` optional; blank keeps the current secret |
| POST | `/api/items/:id/meta` | Same as `POST /api/items/:id` |
| POST | `/api/items/:id/rotate` | `{ "value" }`. Replaces the value only |
| DELETE | `/api/items/:id` | Removes the credential and its approvals |
| POST | `/api/folders` | `{ "environment", "name" }` |
| GET | `/api/need-items/:id` | Operator only. Metadata of a pending collect request. Unauthenticated, or a request from another organization, is 404 |
| POST | `/api/need-items/:id/fulfill` | `{ "value", "name?", "allowed_hosts?", "inject?", "kind?", "username?" }`. Stores the value from the collect page and activates the requesting agent's approval. A `connect` request (an agent needs a provider account) is 409: it is answered from the Inbox card, not typed in |
| POST | `/api/need-items/:id/deny` | Denies a pending request from the Inbox |
| GET | `/collect/:id` | HTML shell for the collect page. Details load only for a signed-in operator |
| POST | `/api/integrations/:provider/start` | `:provider` is `spotify`, `github`, `google`, `slack`, or `stripe` (unknown is 404). `{ "item_name", "environment?", "client_id?", "redirect_uri?", "agent_client_id?", "need_id?" }`. Returns `authorize_url`, `redirect_uri`, and `provider` for a user connect. `agent_client_id` names one agent that gets a standing approval on the refresh credential after connect; `need_id` closes the Inbox request the connect answers |
| GET | `/integrations/:provider/callback` | Operator cookie, authenticator step passed. Exchanges the code, stores the refresh token as `<ITEM>_REFRESH`, redirects to `/console#vault?connected=<provider>` or `?connect_error=<provider>&reason=<code>` (`state_expired`, `provider_denied`, `exchange_failed`, or `no_refresh_token`). `/api/integrations/spotify/start` and `/integrations/spotify/callback` are these routes with `spotify` as the provider |

Names match `[A-Z][A-Z0-9_]{0,127}`. A duplicate name is 409. An empty value is 400.

## Clients, grants, inbox

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/clients/model` | Issues an `avm_...` once, plus `mcp_url`. The token is not listed later |
| POST | `/api/clients/trusted` | Issues an `avt_...` once for `/runtime/resolve` |
| POST | `/api/clients/:id/rotate` | New token once. The old hash stops working |
| POST | `/api/clients/:id/revoke` | Later bearer calls are 401; OAuth tokens are denylisted; approvals revoked. Every OAuth grant this organisation's members gave for the client is destroyed; the same person's grants for it in other organisations survive |
| POST | `/api/grants/request` | Model or operator. `{ "item_name", "task_description?" }`. Returns the grant plus `approval_code`. 30 per organisation per hour |
| POST | `/api/grants/:id/approve` | `{ "policy", "confirm_name?" }`. `folder_standing` is owner-only and needs `confirm_name` |
| POST | `/api/grants/:id/revoke` | Status becomes `revoked`. The row stays listed |
| POST | `/api/grants/approve-by-code` | `{ "code" }`, 8 digits. Reuse is 409, expired is 410 |
| GET, POST | `/approve?token=...` | Email approval link. Operator session required; the token is single use |
| GET | `/api/inbox` | Pending approvals and requests. Each request has a `kind`: `secret` (typed on the collect page) or `connect` (an agent needs a provider account for a stored client secret; the card's Connect button opens the connect dialog with that agent pre-selected) |
| GET | `/api/audit` | Actions, names, and `host` on `auto_approved`. Optional `client_id` and `item_name` filters. No values |

Policies: `prompt` (one successful call, then consumed; a failed call keeps it usable), `session` (8 hours), `item_standing`, `folder_standing`.

## Access

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/access` | Live snapshot: operators, clients, grants, sessions, with created, first and last access, fetched names, and bearer last-4. No ledger array, no tokens |
| GET | `/api/access/events` | Issuance ledger, newest first, limit 200. `jti` is hashed |
| POST | `/api/sessions/:id/revoke` | Only sessions acting in this organisation are listed and revocable. 400 `cannot_revoke_current` for the session making the call |
| POST | `/api/sessions/revoke-others` | Ends every other operator session |

## Trusted resolve

`POST /runtime/resolve` with an `avt_...` bearer and `{ "item_name": "STRIPE_KEY" }` returns the plaintext to the trusted process. This is the hosted equivalent of `vault run`, and it is the inject. A model token is 403.

## MCP

`POST /mcp` JSON-RPC with `http_request`, `find_items`, `list_items`, `request_grant`, `list_grants`. There is no `get_secret`. `GET /mcp` is a server-sent-events keepalive stream. `GET /mcp/tools` returns the tool list. See [MCP tools](/docs/reference/mcp-tools).

## OAuth (botpasses.com is the authorization server)

PKCE S256 is required. Clients are public (`token_endpoint_auth_method` `none`; a registration that asks for a client secret is refused) and use the `code` response type. Access tokens are RS256 JWTs with audience `https://botpasses.com/mcp`, a 600 second lifetime, and an `org_id` claim naming the organisation the operator consented in. Refresh tokens rotate.

| Path | Role |
| --- | --- |
| `/oauth/authorize` | Authorization code. The operator signs in and consents in the browser; the consent is bound to the organisation their session is acting in |
| `/oauth/token` | Code or refresh token to JWT. A refresh for an agent that was revoked in the console is `invalid_grant`; only a new consent brings the agent back |
| `/oauth/jwks` | RS256 public keys. Two are listed while a key rotation is in progress; new tokens are signed with the first |
| `/oauth/register` | Dynamic client registration. `redirect_uris` may be `https`, loopback `http`, or a desktop scheme such as `cursor://`. `javascript:`, `data:`, and `file:` are rejected. 20 per IP per hour |
| `/oauth/device/auth` | RFC 8628 device code. The operator finishes at `/device` (10 code attempts per 15 minutes per IP) |
| `/oauth/revoke` | RFC 7009. Revoking a refresh token also revokes every access token issued with it; a JWT access token is revoked by its `jti`. Marked in the Access ledger |
| `/consent`, `/device` | HTML pages for the two flows above. The consent page's script posts `{ "uid", "decision" }` with `X-CSRF-Token` and `Accept: application/json` and gets `200 { "location" }` to navigate to; a caller with the CSRF header and no such `Accept` gets a 303 to the same resume URL. A form submit without the header (scripts off) is 403 |

## Local vault serve (loopback)

`npx vault serve` listens on `127.0.0.1:8788` and prints two loopback bearers. Send the operator bearer as `Authorization` on `/api/*` (the console stores it) and the model bearer on `POST /mcp` (`vault mcp --remote` sends it). Each is refused on the other surface, so an MCP client cannot approve its own requests. The server answers only to a loopback `Host`.

Each MCP client gets its own session: `initialize` answers with an `Mcp-Session-Id` header, and every later frame must send it back (400 without it, 404 once the server no longer holds it, after 8 idle hours, so the client initializes again). Two clients on one server keep separate agent ids and separate approvals. `vault mcp --remote` handles the header for stdio clients.

| Path | Role |
| --- | --- |
| `GET /` | Local operator console |
| `GET /health` | `{ ok, product }` |
| `GET /api/secrets` | Names, last-4, hosts, inject mode, username as `{ secrets }` |
| `GET /api/items` | The same list as `{ items }`, the hosted key |
| `POST /api/secrets` | Store `{ name, value, allowed_hosts?, inject?, username? }`, answered as `{ secret }`. `username` is the HTTP Basic user, OAuth client id, or AWS access key id |
| `POST /api/items` | The same store, answered as `{ item }` |
| `GET /api/grants` | Grant metadata |
| `POST /api/grants/request` | Request a pending grant |
| `POST /api/grants` | Approve (`scope` is `once` or `session`; `tool_id` is `http_request` for agent calls) |
| `POST /api/grants/:id/revoke` | Revoke |
| `GET /api/audit` | Events, no values |
| `POST /mcp` | Local MCP JSON-RPC, the same five tools as hosted |

There is no OAuth, provider connect, item edit or rotate route, or Access panel on the local plane; `/api/items` only lists and stores.

## Status codes

| Status | When |
| --- | --- |
| 401 | Missing or invalid session or bearer |
| 403 | CSRF, `mfa_required`, wrong channel (a model token on an operator route), foreign Origin on `/api` |
| 404 | Unknown id, or an id from another organisation |
| 409 | Duplicate credential name, reused approval code |
| 410 | Expired approval |
| 413 | Body over 128 KiB |
| 415 | A JSON route was sent a body that is not `application/json` |
| 429 | Rate limit. See [Rate limits](/docs/reference/rate-limits) |
