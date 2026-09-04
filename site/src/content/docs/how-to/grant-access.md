---
title: Approve a request
label: Approve a request
description: How an agent asks to use a credential, the four approval policies, and the three ways to approve. Inbox, 8-digit code, or email link.
section: how-to
order: 2
---

An **approval** (the API calls it a grant) is your permission for one agent to use one credential. Agents cannot approve anything themselves, and nothing in MCP can revoke.

## How a request arrives

1. You ask the agent for a task in plain language: "get my Spotify profile". The agent calls `http_request` with the host, method, and path.
2. Botpasses finds the matching credential by host. If this agent has no active approval for it, Botpasses creates a pending request and returns an `approval_code` to the agent. The agent tells you to approve.
3. Approve in one of the ways below. The agent retries `http_request` and gets a redacted response.

Agents may also call `request_grant` directly with an `item_name`. Same flow.

## Ways to approve

| Where | How |
| --- | --- |
| Console **Inbox** | The card reads "cursor wants STRIPE_SECRET_KEY" with the agent's reason. Pick a policy and approve. |
| **Approve by code** | Type the 8-digit `approval_code` the agent showed you. A code works once; reusing it is a 409. |
| Email | If email is configured for your account, the request also arrives as a link. Opening it shows a confirm page on botpasses.com. |

## Policies

| Policy | Behaviour |
| --- | --- |
| `prompt` | One successful API call, then consumed. The default. |
| `session` | Active for 8 hours or until you revoke. |
| `item_standing` | This agent may use this credential without asking again, until you revoke. |
| `folder_standing` | Owner only. Every credential in the folder or environment is pre-approved for this agent. You type the folder or environment name to confirm. |

A `prompt` approval survives a failed API call. If the API returns 401, 410, or a 5xx, the same approval stays usable and the agent can retry without a new code.

## By API

Operators can `POST /api/grants/:id/approve` with `{ "policy": "prompt" }` or `POST /api/grants/approve-by-code` with `{ "code": "12345678" }`. Both need a session cookie and `X-CSRF-Token`. See the [HTTP API](/docs/reference/http-api#clients-grants-inbox).
