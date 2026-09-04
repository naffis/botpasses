---
title: MCP tools
description: The five hosted MCP tools, their arguments and results, the JSON-RPC methods, auth, and the next steering field. There is no get_secret.
section: reference
order: 1
---

Hosted MCP is `POST https://botpasses.com/mcp` (staging: `https://staging.botpasses.com/mcp`). Protocol version `2024-11-05`, `serverInfo.name` is `botpasses`. The model never receives a secret value. There is no `get_secret`, `read_value`, `reveal_secret`, or `revoke_grant`.

The primary tool is `http_request`. The earlier name `http.request` is accepted as an alias for one release; new integrations should use `http_request`.

## Auth

| Credential | How it is obtained | Notes |
| --- | --- | --- |
| OAuth access token (JWT) | Client completes OAuth on botpasses.com (PKCE S256, dynamic client registration) | `aud` is exactly `https://botpasses.com/mcp`, lifetime 600 s, refresh rotation |
| Model token `avm_...` | Issued once in the console Access panel | Sent as `Authorization: Bearer avm_...`. Sufficient for every method |

Unauthenticated `initialize`, `ping`, `tools/list`, and `notifications/*` succeed, so a client with a preconfigured bearer never sees a connect card. Unauthenticated `tools/call` is 401 with `WWW-Authenticate` carrying `resource_metadata` for `/.well-known/oauth-protected-resource/mcp`. Trusted runtime tokens (`avt_...`) cannot call MCP.

Every agent is bound to one vault environment (`staging` or `production`) when it is issued or connected. Tools act in that environment; there is no environment argument.

## JSON-RPC methods

| Method | Result |
| --- | --- |
| `initialize` | `protocolVersion`, `capabilities.tools`, `serverInfo`, and `instructions` (below) |
| `ping` | `{}` |
| `tools/list` | The five tools with JSON schemas |
| `tools/call` | One `text` content item whose text is the JSON payload described per tool |
| `notifications/*` | No body, HTTP 202 |

Unknown methods return JSON-RPC error `-32601`. Tool exceptions return `-32000` or a result with `isError: true`. `GET /mcp` is an SSE keepalive stream; `GET /mcp/tools` returns the same list as `tools/list`.

## http_request

Call a third-party API. Botpasses finds the credential by host or name, requests an approval if this agent has none, attaches the credential, and returns a redacted response.

| Argument | Required | Notes |
| --- | --- | --- |
| `method` | yes | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `path` | yes | `/v1/me`, or a full `https://` URL. The host is taken from the URL when present |
| `host` | one of host, item_name, or a URL path | Hostname such as `api.stripe.com` |
| `item_name` | one of host, item_name, or a URL path | Exact stored credential name |
| `body` | no | Object for POST, PUT, PATCH. JSON by default; form-encoded when `content_type` says so |
| `content_type` | no | `application/json` or `application/x-www-form-urlencoded` |
| `client_id` | no | Public OAuth client ID when the credential is a client secret |
| `task_description` | no | Shown to the operator in the Inbox, truncated to 500 characters |

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "http_request",
    "arguments": {
      "method": "GET",
      "path": "https://api.stripe.com/v1/balance",
      "task_description": "Check the account balance"
    }
  }
}
```

Success payload: the origin HTTP `status`, the redacted `body` as a string, and sometimes `hint` and `next`.

```json
{
  "status": 200,
  "body": "{\"object\":\"balance\",\"available\":[{\"amount\":125000,\"currency\":\"usd\"}]}",
  "next": { "for_model": "Answer the user from body." }
}
```

Other payloads:

| Payload | Meaning |
| --- | --- |
| `grant_id`, `status: "pending"`, `approval_code`, `item_name`, `notify_failed` | The agent has no active approval. The operator approves in the Inbox or with the 8-digit code. Not an MCP error |
| `status: "need_item"`, `collect_url`, `suggested_name`, `host`, `need_id`, `message` | Nothing stored for that host. The operator opens `collect_url` and types the value. Not an MCP error |
| `host_mismatch` | The named credential is not allowed for that host. MCP `isError: true` |

Connector rules: exact `allowed_hosts` match, no IP literals, DNS resolved and pinned to public addresses, no redirects followed, 10 s timeout, 256 KiB response cap, the credential and any minted access tokens replaced with `[redacted]` in the body.

A `prompt` approval stays usable after the origin returns 401, 410, or 5xx, so the agent can retry with `next.arguments` without a new code.

## find_items

Look up a stored credential by exact `item_name` and/or exact API `host`. Prefer `http_request`, which does this for you.

| Argument | Required |
| --- | --- |
| `item_name` | name and/or host |
| `host` | name and/or host |
| `task_description` | no |

| `status` | Fields | `isError` |
| --- | --- | --- |
| `found` | `item`: `name`, `kind`, `last4`, `allowed_hosts`, `inject`, `environment` | no |
| `ambiguous` | `items` (up to five, `truncated` when more) | no |
| `need_item` | `collect_url`, `suggested_name`, `host`, `client_name`, `need_id`, `message` | no |
| `host_mismatch` | `item` | yes |

Calling with neither name nor host is not an error and does not dump the vault. New `need_item` rows share the 30 per hour limit with `request_grant`.

## list_items

Inventory of credentials in the agent's environment: `name`, `kind`, `last4`, `username`, `environment`, `inject`. No values, no ciphertext.

## request_grant

Requires `item_name`; optional `task_description`. Creates a pending approval and returns the public grant plus `approval_code` and `notify_failed`. Standing policies may activate it at once.

Public grant fields: `grant_id`, `policy`, `status`, `environment_id`, `expires_at`, `created_at`, `approved_at`, `consumed_at`, `task_id`, `task_description`.

## list_grants

Approvals for this agent only. Same public grant fields. No values.

## The next field

Most results include `next.for_model`, and often `next.tool` and `next.arguments` (the host, method, path, or item_name to retry with). Clients that follow `next` never need the user to explain Botpasses.

<details>
<summary>Instructions the server sends to the model</summary>

The `initialize` response carries these instructions. They are written for the model, not for people, and are reproduced here so you know what your agent is told.

> You can call third-party APIs (Spotify, Stripe, GitHub, and the rest) through Botpasses. The user does not need to say Botpasses or name a tool. You never see secret values. When the user wants data from an API, call http_request in the same turn. Do not list_items or find_items first. Do not ask which tool to use. Botpasses finds the credential, asks the operator to grant if needed, and attaches it. Follow next.for_model. Retry with next.arguments when present. If the result has collect_url, tell the user to open that Botpasses page and enter the key there. Do not ask them to paste a secret into this chat. Then retry http_request. If the result has approval_code or grant status pending, tell them to approve in the Botpasses inbox. Then retry http_request with next.arguments. There is no get_secret. Never put a secret in a tool argument. A Client Secret is not a user access token. Prompt grants: if the origin returns 4xx, retry http_request with next.arguments. Do not ask for a new 8-digit code after a failed call.

</details>

## What never appears

- Secret values, ciphertext, raw JWTs, or minted access tokens
- A `get_secret`, `read_value`, or `revoke_grant` tool
- A collect URL that encodes the secret (`collect_url` is a path on botpasses.com with no signature)

## Local MCP (SQLite)

`npx vault mcp` exposes `list_secrets`, `request_grant` (`secret_name`, `agent_id`, `tool_id`, optional `scope` of `once` or `session`), and `list_grants`. Inject on the local plane is `vault run`; there is no `http_request` and no `collect_url`. A miss is an MCP error that tells the operator to store the name with `vault set`.

## Related

- [HTTP API](/docs/reference/http-api): the routes that wrap the same vault.
- [Rate limits](/docs/reference/rate-limits).
- [Troubleshooting](/docs/troubleshooting): `host_mismatch`, pending approvals, connect cards.
