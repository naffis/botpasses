# MCP reference (internal)

Canonical tool list, JSON-RPC, and payload contracts. Public copy: [site MCP tools](../../site/src/content/docs/reference/mcp-tools.md). Implementation: [src/hosted/mcp.ts](../../src/hosted/mcp.ts) (hosted), [src/mcp.ts](../../src/mcp.ts) (local). Steering copy: [src/prompts/mcp-hosted.ts](../../src/prompts/mcp-hosted.ts).

There is no `get_secret`, `read_value`, `read_secret`, `reveal_secret`, `decrypt_secret`, `export_secret`, or `revoke_grant` on MCP. Revoke is operator-only.

## Two planes

| Plane | Transport | Tools | Auth |
| --- | --- | --- | --- |
| Hosted | `POST /mcp` JSON-RPC; stdio via `vault mcp --user-jwt` | `list_items`, `find_items`, `request_grant`, `list_grants`, `http_request` | Model JWT (`aud=${origin}/mcp`) or `avm_…` Bearer. Operator session may call MCP as a model for the chosen environment. |
| Local | `npx vault mcp` stdio; `POST /mcp` on `vault serve` | Same five tools as hosted (`list_secrets` and `http.request` accepted as aliases for one release) | Loopback HMAC Bearer on `POST /mcp` (`vault serve` prints it). Stdio uses the local sqlite vault. |

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

Unauthenticated hosted `initialize`, `ping`, `tools/list`, and `notifications/*` succeed so a Grok Bot with only an `avm_` header does not see a connect card. Unauthenticated `tools/call` is **401** with `WWW-Authenticate` `resource_metadata` set to the absolute path-aware PRM URL. A valid `Authorization: Bearer avm_…` is sufficient for every method. MCP hosts on other origins may call `/mcp` and well-known (CORS reflects their Origin; no cookies). Operator `/api` still 403s a foreign Origin. `GET /mcp` is an SSE keepalive stream and requires a model or operator principal (401 otherwise). DCR redirect URIs may be `https`, IP-literal loopback `http` (`127.0.0.1`, `[::1]`), or a named desktop scheme (cursor, cursor-mcp, vscode, vscode-insiders, grok, xai, xai-grok). Cookie-authenticated operator sessions may call `POST /mcp` only with `X-CSRF-Token` and a same-origin `Origin`.

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
| `body` | no | Object for POST/PUT/PATCH. JSON by default; form-urlencoded when `content_type` says so or the path is Spotify `/api/token` |
| `content_type` | no | `application/json` or `application/x-www-form-urlencoded` |
| `client_id` | no | Public OAuth Client ID when the item is a Client Secret |
| `task_description` | no | Shown in the inbox, truncated to 500 characters |
| `timeout_ms` | no | Origin deadline in ms, 1000 to 30000 (default 10000); out-of-range values are clamped, non-numbers are 400 |
| `dry_run` | no | `true`: resolve the item and approval and report without calling the API or using an approval |

Implementation: [src/hosted/mcp-http.ts](../../src/hosted/mcp-http.ts) `runHttpRequest`, [src/hosted/connector.ts](../../src/hosted/connector.ts).

Success body: `origin_status` (the API's HTTP status), redacted `body` (string), `origin_headers` (only `content-type`, `link`, `retry-after`, `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `x-request-id`), optional `hint`, optional `next`. `status` duplicates `origin_status` for one release and is deprecated. Never the secret. Connector rules: exact `allowed_hosts`, no IP literals, DNS pin to public addresses, no redirects. Dry run body: `{ dry_run: true, item_name, host, method, path, would_send, reason, grant_status, inject_mode, provider }` where `reason` is `ok`, `need_item`, `ambiguous`, `host_mismatch`, `grant_required`, `grant_pending`, or `inject_unsupported` and `grant_status` is `standing`, `active`, `pending`, or `none`.

Providers: Botpasses mints and refreshes OAuth tokens for known providers (Spotify, GitHub, Google, Slack, Stripe Connect); pass `client_id` when the item is an OAuth client secret. Client credentials go to the provider token endpoint as HTTP Basic or form fields, per provider, never as Bearer. Paths that need a user token return a hint; a stored `<ITEM>_REFRESH` item is exchanged automatically. Refresh sends `refresh_token` and `client_id` in the form body (RFC 6749 section 6).

Inject modes on items: `bearer`, `basic`, `client_credentials`, `refresh`, `sigv4`, `header:<name>`, `query:<param>`, `cookie:<name>`, `hmac:stripe_sig|slack_sig|github_sig`. Unknown modes are 400 at store time and 500 `inject_unsupported` at send time; nothing falls through to Bearer.

If the item is missing, the result is `need_item` (not MCP `isError`) with `collect_url` (`${origin}/collect/:needId`, no HMAC). If a grant is required, the result is a pending grant plus `approval_code`. `host_mismatch` is MCP `isError`.

A Client Secret is not a user access token. On `accounts.spotify.com` Botpasses sends HTTP Basic, not Bearer. Token mint uses a form body. App tokens can call `GET /v1/search`. `GET /v1/me` needs a user connect (Authorization Code + PKCE); the tool result says so instead of treating client credentials as a user token. Access tokens in origin JSON are `[redacted]`.

Prompt grants stay reusable after a failed origin 4xx (401/410). Retry with `next.arguments`. Do not ask for a new 8-digit code.

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
| `need_item` | Miss. `collect_url`, `suggested_name`, `host`, `client_name`, `need_id`, `message` | no |
| `host_mismatch` | Named item is not allowlisted for that host | **yes** |

Neither name nor host is an error (not a dump). Rate limit on new needs: 30 per org per hour (same limiter as `request_grant`).

### `list_items`

Inventory: `name`, `kind`, `last4`, `username`, `environment`, `inject`. No values, no ciphertext.

### `request_grant`

Optional `host`, `method`, `path`: the call the agent will make. `host` must be one of the item's allowed hosts, `method` one of GET POST PUT PATCH DELETE, `path` must start with `/`; otherwise 400 (`host_mismatch` carries `allowed_hosts`). Stored on the pending grant as `requested_scope` and shown on the inbox card. When the operator approves without limits, the grant is scoped to that method, host, and path prefix.

Public grant fields gain `requested_scope` (`{ host, method, path }` or null) and `grant_scope` (`{ methods, path_prefixes, hosts, max_calls, calls_used, expires_at }`, or null when unrestricted). `list_items` items include `allowed_hosts` and `kind`.

A scoped grant refuses a call outside its scope with 403 `scope_denied`: `{ status: "scope_denied", reason: "method" | "host" | "path", grant_id, grant_scope }`. Grants with `max_calls` become `consumed` on the last call and the standing policy behind them is removed. `find_items` is optional; `http_request` finds the item itself.

Returns the existing open grant for this client and item (an active one as-is; a pending one with a fresh `approval_code`). Ten calls yield one grant, not ten. Counted against the org rate limit (30 per hour) inside the kernel, so `http_request` and REST share the same budget.

Requires `item_name`; optional `task_description`. Returns public grant fields (including `task_id`) plus `approval_code` and `notify_failed`. Never the secret. Standing policies may activate immediately.

Public grant fields: `grant_id`, `policy`, `status`, `environment_id`, `expires_at`, `created_at`, `approved_at`, `consumed_at`, `task_id`, `task_description`.

### `list_grants`

Grants for **this client** only. Same public grant fields.

## `next` steering

Origin 4xx: "The request was rejected by the API; change the path, query, or body before retrying. Do not ask for a new approval." Origin 5xx: "Transient origin error; retry once." 401/410 keep the same-approval retry text. A failed connection says what failed (DNS, TLS, connect, timeout, blocked address) without the secret or the raw error message.

[src/hosted/mcp-steer.ts](../../src/hosted/mcp-steer.ts) `attachMcpNext` adds `next.for_model`, optional `next.tool`, and `next.arguments` (retry host/method/path/item_name). The model should follow `next` and not invent a paste-the-secret step.

## Local tools

`vault mcp` (stdio, SQLite) exposes the same five tools as hosted: `list_items`, `find_items`, `request_grant`, `list_grants`, `http_request`, with the same argument shapes. `list_secrets` and `http.request` are accepted aliases for one release. The agent id comes from the MCP client's `initialize` `clientInfo.name`. `http_request` requires an active grant for `(item, agent, http_request)` (`vault grant --secret NAME --agent A --tool http_request`), decrypts in-process, and calls the shared connector; the result is redacted like hosted. Items get hosts and an inject mode with `vault set NAME --host api.example.com --inject bearer`. A miss returns `need_item` with a message to run `vault set`; there is no `collect_url` locally.

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
