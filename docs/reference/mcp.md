# MCP reference (internal)

Canonical tool list, JSON-RPC, and payload contracts. Public copy: [site MCP tools](../../site/src/pages/docs/reference/mcp-tools.astro). Implementation: [src/hosted/mcp.ts](../../src/hosted/mcp.ts) (hosted), [src/mcp.ts](../../src/mcp.ts) (local). Steering copy: [src/prompts/mcp-hosted.ts](../../src/prompts/mcp-hosted.ts).

There is no `get_secret`, `read_value`, `read_secret`, `reveal_secret`, `decrypt_secret`, `export_secret`, or `revoke_grant` on MCP. Revoke is operator-only.

## Two planes

| Plane | Transport | Tools | Auth |
| --- | --- | --- | --- |
| Hosted | `POST /mcp` JSON-RPC; stdio via `vault mcp --user-jwt` | `list_items`, `find_items`, `request_grant`, `list_grants`, `http.request` | Model JWT (`aud=${origin}/mcp`) or `avm_…` Bearer. Operator session may call MCP as a model for the chosen environment. |
| Local | `npx vault mcp` stdio; `POST /mcp` on `vault serve` | `list_secrets`, `request_grant`, `list_grants` | Loopback HMAC Bearer on `POST /mcp` (`vault serve` prints it). Stdio uses the local sqlite vault. |

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

Unauthenticated hosted `POST /mcp` is **401** with `WWW-Authenticate` `resource_metadata` set to the absolute path-aware PRM URL. MCP hosts on other origins may call `/mcp` and well-known (CORS reflects their Origin; no cookies). Operator `/api` still 403s a foreign Origin. `GET /mcp` is SSE keepalive for an authenticated model or operator.

`GET /mcp/tools` (hosted, model or operator) returns the same tool list as `tools/list`.

## Hosted tools

Environment on every hosted tool is the **client's** vault environment (`staging` or `production`), not the argument. The `environment` schema field is accepted and ignored for isolation.

### `http.request` (primary)

Call this in the same turn the user asks for an API. Do not `list_items` first.

| Argument | Required | Notes |
| --- | --- | --- |
| `method` | yes | `GET` `POST` `PUT` `PATCH` `DELETE` |
| `path` | yes | `/v1/me` or a full `https://` URL. Host is taken from the URL. |
| `host` | one of host / item_name / URL path | Hostname such as `api.spotify.com` |
| `item_name` | one of host / item_name / URL path | Exact stored name |
| `body` | no | JSON object for POST/PUT/PATCH |
| `task_description` | no | Shown in the inbox, truncated to 500 characters |

Implementation: [src/hosted/mcp-http.ts](../../src/hosted/mcp-http.ts) `runHttpRequest`, [src/hosted/connector.ts](../../src/hosted/connector.ts).

Success body: HTTP `status`, redacted origin `body`, optional `next`. Never the secret. Connector rules: exact `allowed_hosts`, no IP literals, DNS pin to public addresses, no redirects.

If the item is missing, the result is `need_item` (not MCP `isError`) with `collect_url` (`${origin}/collect/:needId`, no HMAC). If a grant is required, the result is a pending grant plus `approval_code`. `host_mismatch` is MCP `isError`.

### `find_items`

Lookup only. Prefer `http.request`.

| Argument | Required |
| --- | --- |
| `item_name` | no (need name and/or host) |
| `host` | no |
| `task_description` | no |

Statuses ([src/hosted-types.ts](../../src/hosted-types.ts) `FindItemsResult`):

| `status` | Meaning | `isError` |
| --- | --- | --- |
| `found` | One item. Fields: name, kind, last4, allowed_hosts, inject, environment | no |
| `ambiguous` | More than one host match (`truncated` if more than five) | no |
| `need_item` | Miss. `collect_url`, `suggested_name`, `host`, `client_name`, `need_id`, `message` | no |
| `host_mismatch` | Named item is not allowlisted for that host | **yes** |

Neither name nor host is an error (not a dump). Rate limit on new needs: 30 per org per hour (same limiter as `request_grant`).

### `list_items`

Inventory: `name`, `kind`, `last4`, `username`, `environment`, `inject`. No values, no ciphertext.

### `request_grant`

Requires `item_name`. Returns public grant fields plus `approval_code` and `notify_failed`. Never the secret. Standing policies may activate immediately.

Public grant fields: `grant_id`, `policy`, `status`, `environment_id`, `expires_at`, `created_at`, `approved_at`, `consumed_at`, `task_id`, `task_description`.

### `list_grants`

Grants for **this client** only. Same public grant fields.

## `next` steering

[src/hosted/mcp-steer.ts](../../src/hosted/mcp-steer.ts) `attachMcpNext` adds `next.for_model`, optional `next.tool`, and `next.arguments` (retry host/method/path/item_name). The model should follow `next` and not invent a paste-the-secret step.

## Local tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_secrets` | none | `{ secrets: [{ name, last4, created_at, updated_at }] }` |
| `request_grant` | `secret_name`, `agent_id`, `tool_id`, optional `scope` (`once` \| `session`) | Public grant, or `need_item` with a store message (no `collect_url`) |
| `list_grants` | optional `agent_id`, `tool_id` | `{ grants }` with secret_name, agent_id, tool_id, scope, status, timestamps |

Local inject is `vault run`, not `http.request`. Local `need_item` is MCP `isError`.

## Auth and isolation

- Model tokens (`avm_…` or OAuth JWT) cannot call operator APIs or `/runtime/resolve`.
- Trusted tokens (`avt_…`) cannot call MCP.
- Staging clients cannot see production items.
- Hosted MCP never provisions an org.
- Isolation tests fail if a canary secret appears in MCP JSON, collect HTML, or email.

## Related

- HTTP routes that wrap the same kernel: [http-api.md](./http-api.md)
- Why values stay out of context: [site explanation](../../site/src/pages/docs/explanation/why-the-model-never-sees-the-value.astro)
- ADR [0004](../adr/0004-same-origin-oauth-as.md)
