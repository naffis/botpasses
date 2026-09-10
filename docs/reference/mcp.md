# MCP reference (internal)

Canonical tool list, JSON-RPC, and payload contracts. Public copy: [site MCP tools](../../site/src/content/docs/reference/mcp-tools.md). Implementation: [src/hosted/mcp.ts](../../src/hosted/mcp.ts) (hosted), [src/mcp.ts](../../src/mcp.ts) (local). Steering copy: [src/prompts/mcp-hosted.ts](../../src/prompts/mcp-hosted.ts).

There is no `get_secret`, `read_value`, `read_secret`, `reveal_secret`, `decrypt_secret`, `export_secret`, or `revoke_grant` on MCP. Revoke is operator-only.

## Two planes

| Plane | Transport | Tools | Auth |
| --- | --- | --- | --- |
| Hosted | `POST /mcp` JSON-RPC; stdio via `vault mcp --user-jwt` | `list_items`, `find_items`, `request_grant`, `list_grants`, `setup`, `http_request` | Model JWT (`aud=${origin}/mcp`) or `avm_…` Bearer. Operator session may call MCP as a model for the chosen environment. |
| Local | `npx vault mcp` stdio; `POST /mcp` on `vault serve` | Same six tools as hosted (`list_secrets` and `http.request` accepted as aliases for one release) | Loopback **model** Bearer on `POST /mcp` (`vault serve` prints it next to the operator bearer; the operator bearer is refused there), plus the `Mcp-Session-Id` that `initialize` issued (400 without it, 404 when unknown or idle 8 hours). `vault mcp --remote` forwards stdio to `vault serve` with the model bearer and carries the session id. Plain `vault mcp` stdio uses the local sqlite vault directly, one session per process. |

Hosted `serverInfo.name` is `botpasses`. Protocol version is `2024-11-05`. Port is **8788** (never 8787).

## JSON-RPC methods

Both planes implement:

| Method | Result |
| --- | --- |
| `initialize` | `protocolVersion`, `capabilities.tools`, `serverInfo`, `instructions` |
| `ping` | `{}` |
| `tools/list` | `{ tools }` |
| `tools/call` | MCP content list. Tool JSON is a single `text` item. |
| `notifications/*` | No JSON-RPC body (HTTP 202 on hosted/local HTTP). |

Unknown methods: `{ error: { code: -32601 } }`. Tool exceptions: `{ error: { code: -32000 } }` or a tool result with `isError: true`.

Unauthenticated hosted `initialize`, `ping`, `tools/list`, and `notifications/*` succeed so a Grok Bot with only an `avm_` header does not see a connect card. Unauthenticated `tools/call` and `GET /mcp` (the SSE listen) are **401** with `WWW-Authenticate` `resource_metadata` set to the absolute path-aware PRM URL, so a Streamable HTTP host can start OAuth. A valid `Authorization: Bearer avm_…` is sufficient for every method. MCP hosts on other origins may call `/mcp` and well-known (CORS reflects their Origin; no cookies). Operator `/api` still 403s a foreign Origin. DCR redirect URIs may be `https`, RFC 8252 loopback `http` (`127.0.0.1`, `[::1]`, `localhost`), or a named desktop scheme (cursor, cursor-mcp, vscode, vscode-insiders, grok, grokbot, xai, xai-grok). Cookie-authenticated operator sessions may call `POST /mcp` only with `X-CSRF-Token` and a same-origin `Origin`.

`GET /mcp/tools` (hosted, model or operator) returns the same tool list as `tools/list`.

## Hosted tools

Environment on every hosted tool is the **client's** vault environment (`staging` or `production`). There is no `environment` argument; the field was removed from the tool schemas because it was always ignored.

### `http_request` (primary)

The tool was named `http.request` before; that name is kept as an alias for one release because some hosts reject a dot in a tool name. Docs, prompts, and `next.tool` use `http_request`.

Call this in the same turn the user asks for an API. Do not `list_items` first. Public URL: `https://botpasses.com/mcp` (staging `https://staging.botpasses.com/mcp`).

| Argument | Required | Notes |
| --- | --- | --- |
| `method` | yes | `GET` `POST` `PUT` `PATCH` `DELETE` |
| `path` | yes | `/v1/me` or a full `https://` URL. Host is taken from the URL. |
| `host` | one of host / item_name / URL path | Hostname such as `api.spotify.com` |
| `item_name` | one of host / item_name / URL path | Exact stored name |
| `body` | no | Object for POST/PUT/PATCH. JSON by default; form-urlencoded when `content_type` says so or the path is a known provider token endpoint |
| `content_type` | no | `application/json` or `application/x-www-form-urlencoded` (case-insensitive; a charset parameter is dropped). Anything else is 400 |
| `client_id` | no | Public OAuth Client ID when the item is a Client Secret. Redaction covers the Basic pair under this id as well as the stored username |
| `task_description` | no | Shown in the inbox, truncated to 500 characters |
| `timeout_ms` | no | Origin deadline in ms, 1000 to 30000 (default 10000); out-of-range values are clamped, non-numbers are 400 |
| `dry_run` | no | `true`: resolve the item and approval and report without calling the API or using an approval |

Paths are canonical everywhere: `path` (or the URL path) is validated once by `canonicalRequestPath` ([src/hosted/ssrf.ts](../../src/hosted/ssrf.ts)) and the same string is stored on the grant, shown on the inbox card, and checked against the approval scope. The connector then sends that string on the wire, except one compatibility rewrite: on `api.spotify.com`, `GET`/`POST`/`PUT`/`DELETE` `/v1/playlists/{id}/tracks` is sent as `/v1/playlists/{id}/items` (Spotify February 2026 playlist content rename). Other `/tracks` paths are not rewritten. On `DELETE`, a JSON body that still uses the `tracks` key is sent with `items` instead. The result sets `path_rewritten`, `requested_path`, and `rewritten_path` (and `body_key_mapped: "tracks->items"` when the body key moved); `next.for_model` says so. Grant scope still uses the path the agent sent. Refused with 400: backslashes, control characters, percent-encoded `/`, `\`, or `.` inside a segment at any encoding depth (`%2F`, `%5C`, `%2E`, and the double-encoded `%252F`, `%252E`, which an origin decodes again), a percent-encoded NUL (`%00`, `%2500`), `.` or `..` segments in any encoding or with a `;param` suffix, whitespace, a fragment, malformed escapes, a scheme, and paths over 2048 characters. A URL or host with a port other than 443 is 400 with a hint; Botpasses connects on 443 only.

Implementation: [src/hosted/mcp-http.ts](../../src/hosted/mcp-http.ts) `runHttpRequest`, [src/hosted/connector.ts](../../src/hosted/connector.ts).

Success body: `origin_status` (the API's HTTP status), redacted `body` (string), `origin_headers` (only `content-type`, `link`, `retry-after`, `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `x-request-id`), optional `hint`, optional `next`. `status` duplicates `origin_status` for one release and is deprecated. Never the secret. Connector rules: exact `allowed_hosts` (compared case-insensitively; stored lowercase), no IP literals, DNS pin to public addresses, no redirects, `accept-encoding: identity`. An origin body over 1 MiB on the wire is cut at the socket and returned as `origin_status: 502` with body `{ "error": "body_too_large", "hint" }` (its `origin_headers` are redacted like any other answer's); an origin that closes the connection mid-response fails the call at once (502, "closed the connection before the response completed") instead of waiting for the deadline. A bodiless answer (204, 205, 304) is returned with an empty `body`; a status outside 100 to 599 is a 502 error with `status: "bad_status"` and `origin_status`. Both count as an origin answer, so a one-call approval stays spent. Dry run body: `{ dry_run: true, item_name, host, method, path, would_send, reason, grant_status, inject_mode, provider }` where `reason` is `ok`, `need_item`, `ambiguous`, `host_mismatch`, `grant_required`, `grant_pending`, `scope_denied` (the approval a real call would use does not cover this method, host, or path), `user_connect_required` (a provider user-only path with only the app credential stored; see below), or `inject_unsupported` and `grant_status` is `standing`, `active`, `pending`, or `none`. `standing` means a standing policy that is still live (not expired, `max_calls` not spent); a stale policy reads as `none` and is left in place, because a dry run writes nothing.

Providers: Botpasses mints and refreshes OAuth tokens for known providers (Spotify, GitHub, Google, Slack, Stripe Connect); pass `client_id` when the item is an OAuth client secret. Client credentials go to the provider token endpoint as HTTP Basic or form fields, per provider, never as Bearer. Paths that need a user token use the stored `<ITEM>_REFRESH` item: a cached access token is used without touching the refresh item's approval; otherwise the refresh item needs an active approval for this client, and when it has none the result is the pending grant for `<ITEM>_REFRESH` (with `approval_code`, `item_name`, and a `hint`), not an app-token call that 401s.

When there is no `<ITEM>_REFRESH` at all (or no client id) and the item is the app credential (`client_secret`, or `client_credentials` / `basic` inject), the call is refused before dialing with `{ status: "user_connect_required", provider, item_name, refresh_item_name, connect_url, need_id, hint }`. Nothing is sent, so a one-call approval comes back (audit `inject_denied`). `connect_url` is a console deep link on the plane's public origin, `${origin}/console#credentials/item/<sourceItemId>?connect=<provider>&agent=<clientId>&need=<needId>`: it opens the connect dialog for the item with "Also allow <agent> to use the connected account" checked, so the operator's connect also writes the agent's standing policy on `<ITEM>_REFRESH`. The same request is recorded as an inbox need of kind `connect` (`suggested_name` is `<ITEM>_REFRESH`, `host` the provider API host; audit `connect_requested` once per row); repeated calls reuse the pending row and return the same `need_id` until the operator connects (the callback marks it fulfilled) or denies it (`need_denied`). `dry_run` reports `reason: "user_connect_required"` without creating anything. The model hands the link to the operator, waits for them to confirm, then retries the same call once; the retry goes through the cache-first user-token path with `user_token: true` and no further inbox card. A plain user token stored for the API host (`bearer`) is not an app credential and is sent as before. The refresh exchange (RFC 6749 section 6) sends `grant_type=refresh_token` and the stored refresh token in the form body and authenticates the app the way the connect exchange did: the client secret item (the `<ITEM>` the `<ITEM>_REFRESH` belongs to, already approved for the call) goes out as HTTP Basic or as `client_id` and `client_secret` form fields, per provider. Both items must allow the provider token host (400 `inject_denied` with a hint otherwise). Neither value reaches the result or the audit. When the provider rotates the refresh token, the new value replaces the stored `<ITEM>_REFRESH` value in place (audit `refresh_rotated`, actor `provider`).

An agent may also post `<ITEM>_REFRESH` to the provider token endpoint itself (`item_name: <ITEM>_REFRESH`, `POST` to the token host and path, body `grant_type=refresh_token` or none). It needs only its approval on the refresh item. Botpasses reads the sibling client secret item from the same environment (`<ITEM>_SECRET`, then `<ITEM>`; when both exist, the one whose username is the refresh item's client id) and builds the same exchange as above: the secret per the provider's token auth, `grant_type=refresh_token` and the refresh token in the form; both items must allow the token host. The result is the redacted token body plus `refreshed: true` and `token_last4`; the minted user token is cached for the user-token path and a rotated refresh token is persisted as above. Audit: `inject` for the refresh item and for the sibling, both under the calling agent. Without a sibling, a provider with PKCE (Spotify, Google) gets the public-client exchange (`client_id` alone); any other provider would answer `invalid_client`, so the call is refused before dialing with `{ status: "inject_denied", item_name, missing_item, hint }` (a one-call approval comes back). A body whose `grant_type` is anything but `refresh_token` is a 400.

Inject modes on items: `bearer`, `basic`, `client_credentials`, `refresh`, `sigv4`, `header:<name>`, `query:<param>`, `cookie:<name>`, `hmac:stripe_sig|slack_sig|github_sig`. Unknown modes are 400 at store time and 500 `inject_unsupported` at send time; nothing falls through to Bearer.

If the item is missing, the result is `need_item` (not MCP `isError`) with `collect_url` (`${origin}/collect/:needId`, no HMAC). If a grant is required, the result is a pending grant plus `approval_code`. `host_mismatch` is MCP `isError`.

A Client Secret is not a user access token. On `accounts.spotify.com` Botpasses sends HTTP Basic, not Bearer. Token mint uses a form body. App tokens can call `GET /v1/search`. `GET /v1/me` needs a user connect (Authorization Code + PKCE); the tool result says so instead of treating client credentials as a user token. Playlist add, list, reorder, and remove use `/v1/playlists/{id}/items` (not `/tracks`). Access tokens in origin JSON are `[redacted]`.

A `prompt` (one-call) grant is spent the moment the credential leaves the process: any origin status (2xx, 401, 410, 5xx, `body_too_large`), a connection closed mid-response, or a timeout after the TLS handshake all consume it. It is handed back only when the send never left: the connector refused before dialing (host mismatch, blocked address, unusable mode, missing client id, `user_connect_required`) or the origin was unreachable before the handshake (DNS, connect, TLS, or a deadline before it). Operators who expect retries approve with `max_calls` or `session`. Retry with `next.arguments`; if the retry returns a pending grant, the operator approves it.

### `find_items`

Lookup only. Prefer `http_request`.

| Argument | Required |
| --- | --- |
| `item_name` | no (need name and/or host) |
| `host` | no |
| `task_description` | no |

Statuses ([src/hosted-types.ts](../../src/hosted-types.ts) `FindItemsResult`):

| `status` | Meaning | `isError` |
| --- | --- | --- |
| `found` | One item (`item`). Fields: `name`, `kind`, `last4`, `allowed_hosts`, `inject`, `environment` | no |
| `ambiguous` | More than one host match (`truncated` if more than five) | no |
| `need_item` | Miss. `collect_url`, `suggested_name`, `host`, `client_name`, `need_id`, `message`, optional `recipe` when the host matches a setup recipe | no |

Inbox needs have a `kind`: `secret` (the operator types the value on `collect_url`) or `connect` (created by `http_request`'s `user_connect_required`; the operator connects a provider account from the inbox card, and the collect page refuses it). Both expire like a magic link and are swept when expired, cancelled, or denied.
| `host_mismatch` | Named item is not allowlisted for that host | **yes** |

Neither name nor host is an error (not a dump). Rate limit on new needs: 30 per org per hour (same limiter as `request_grant`).

### `setup`

When the user asked to set up, store, or connect credentials for a provider or API and is not asking for data yet. Pass exactly one of `provider` (`spotify` | `github` | `google` | `slack` | `stripe`) or `host`. Both, even when they agree, is 400. Optional `task_description` and `dry_run`. No secret arguments.

Statuses: `need_item` (path-only `collect_url`), `user_connect_required` (console `connect_url`, no HMAC), `ready`, `ready_prompt` (item stored; ask the operator to Always-allow in Inbox), `ambiguous`. Hosted `need_item` / `ready` / `ready_prompt` / `user_connect_required` are not MCP `isError`. Results include public `recipe` (when known), `steps[]` (`id`, `label`, `state` of done, current, or not started, optional `url`), and `next`. After Collect, call `setup` again. After `ready`, call `http_request`. `dry_run` reports the same status without inserting a need.

Known recipes: Spotify (`SPOTIFY_SECRET`, Client ID + secret, then Connect), Stripe secret key (`STRIPE_SECRET_KEY`, `sk_`, not Connect), GitHub PAT, Google OAuth client + Connect, Slack bot/user token. An unknown host uses today's generic Collect (`API_EXAMPLE_COM`, secret/bearer). A leftover host-named item (for example `API_SPOTIFY_COM` bearer) is reused as `ready` or `ready_prompt`; setup does not create `SPOTIFY_SECRET` beside it or start Connect.

Implementation: [src/hosted/mcp-setup.ts](../../src/hosted/mcp-setup.ts).

### `list_items`

Inventory: `name`, `kind`, `last4`, `username`, `environment`, `inject`. No values, no ciphertext.

### `request_grant`

Optional `host`, `method`, `path`: the call the agent will make. `host` must be one of the item's allowed hosts, `method` one of GET POST PUT PATCH DELETE, `path` must pass the same canonical-path rules as `http_request` (starts with `/`, no encoded separators or dot segments); otherwise 400 (`host_mismatch` carries `allowed_hosts`). Stored on the pending grant as `requested_scope` in canonical form and shown on the inbox card. When the operator approves without limits, the grant is scoped to that method, host, and path prefix. `task_description` is cut to 500 characters.

Public grant fields gain `requested_scope` (`{ host, method, path }` or null) and `grant_scope` (`{ methods, path_prefixes, hosts, max_calls, calls_used, expires_at }`, or null when unrestricted). `list_items` items include `allowed_hosts` and `kind`.

A scoped grant refuses a call outside its scope with 403 `scope_denied`: `{ status: "scope_denied", reason: "method" | "host" | "path", grant_id, grant_scope }`. Grants with `max_calls` become `consumed` on the last call and the standing policy behind them is removed. `find_items` is optional; `http_request` finds the item itself.

Returns the existing open grant for this client and item when that grant covers the stated call, or when the agent stated no call (an active one as-is; a pending one with a fresh `approval_code`). A standing or active grant whose `grant_scope` does not admit the stated host, method, or path does not satisfy the request: a pending grant is created (or reused) for that scope so the operator can approve it. Ten covering calls yield one grant, not ten. Counted against the org rate limit (30 per hour) inside the kernel, so `http_request` and REST share the same budget.

Requires `item_name`; optional `task_description`. Returns public grant fields (including `task_id`) plus `approval_code` and `notify_failed`. Never the secret. Standing policies may activate immediately when they cover the call.

Public grant fields: `grant_id`, `policy`, `status`, `environment_id`, `expires_at`, `created_at`, `approved_at`, `consumed_at`, `task_id`, `task_description`.

### `list_grants`

Grants for **this client** only. Same public grant fields.

## `next` steering

Origin 4xx: "The request was rejected by the API; change the path, query, or body before retrying. Do not ask for a new approval." Origin 5xx: "Transient origin error; retry once." A `body_too_large` 502 is not transient: the model is told the response was larger than 1 MiB, not to retry the same call, and to narrow it (pagination, a smaller page, a fields filter) first. 401/410, 5xx, and `body_too_large` add that a standing or session approval still covers the retry while a one-call approval was spent by the answer. A failed connection says what failed (DNS, TLS, connect, timeout, premature close, blocked address) without the secret or the raw error message.

`user_connect_required`: "Give the user connect_url and ask them to connect their account there; do not retry until they confirm; then call http_request once with next.arguments."

[src/hosted/mcp-steer.ts](../../src/hosted/mcp-steer.ts) `attachMcpNext` adds `next.for_model`, optional `next.tool`, and `next.arguments` (retry host/method/path/item_name). The model should follow `next` and not invent a paste-the-secret step.

## Local tools

`vault mcp` (stdio, SQLite) exposes the same six tools as hosted: `list_items`, `find_items`, `request_grant`, `list_grants`, `setup`, `http_request`, with the same argument shapes. Local `setup` returns a `vault set` command (no `--kind`) instead of `collect_url`. `list_secrets` and `http.request` are accepted aliases for one release. The agent id comes from the MCP client's `initialize` `clientInfo.name` and nothing else: an argument the tool schema does not name (`agent_id`, `tool_id`, `secret_name`, `environment`) is refused with JSON-RPC `-32602` (`Invalid params: unknown argument ...`), or `isError` when the tool is called directly. Over `POST /mcp` on `vault serve` that agent id lives in the session `initialize` opened: the response carries `Mcp-Session-Id`, later frames send it back, and a second client's `initialize` opens its own session instead of renaming the first client's agent. `http_request` requires an active grant for `(item, agent, http_request)` (`vault grant --secret NAME --agent A --tool http_request`), decrypts in-process, and calls the shared connector; the result is redacted like hosted and carries `origin_status`, `origin_headers`, and the deprecated `status`. `client_id` (overrides the stored username for one call), `timeout_ms`, and `dry_run` work as on hosted; the dry-run report has the same fields (`grant_status` is `active`, `pending`, or `none`). A `once` grant follows the hosted rule: any origin answer spends it; it comes back only when the value never left the process. Items take hosts, an inject mode from the hosted vocabulary, and a username with `vault set NAME --host api.example.com --inject basic --username svc`. A miss returns `need_item` with a message to run `vault set`; there is no `collect_url` locally. A known provider's user-only path (Spotify `/v1/me`) called with a `client_credentials` item and no local `<ITEM>_REFRESH` is refused before dialing with `{ status: "user_connect_required", provider, item_name, refresh_item_name, hint }` (a `once` grant stays active, audit `inject_denied`); there is no `connect_url` locally, and the hint says to store the refresh token with `vault set <ITEM>_REFRESH --host <api,token hosts> --inject refresh --username <client id>` and retry.

## Auth and isolation

- Model tokens (`avm_…` or OAuth JWT) cannot call operator APIs or `/runtime/resolve`.
- Trusted tokens (`avt_…`) cannot call MCP.
- Staging clients cannot see production items.
- Hosted MCP never provisions an org.
- Isolation tests fail if a canary secret appears in MCP JSON, collect HTML, or email.

## Related

- HTTP routes that wrap the same kernel: [http-api.md](./http-api.md)
- Why values stay out of context: [site explanation](../../site/src/content/docs/explanation/why-the-model-never-sees-the-value.md)
- ADR [0004](../adr/0004-same-origin-oauth-as.md)
