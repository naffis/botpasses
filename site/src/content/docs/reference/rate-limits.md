---
title: Rate limits and size caps
label: Rate limits
description: The request limits, lifetimes, and size caps enforced by botpasses.com, and what the 429 means for an agent that hits one.
section: reference
order: 4
---

Limits are fixed per organisation or per IP address. Hitting one returns HTTP 429 (or, inside an MCP tool result, an error the agent should show you). Waiting for the window to pass is the fix; there is no override.

## Requests

| What | Limit | Scope |
| --- | --- | --- |
| New approval requests (`request_grant`, `http_request` needing an approval, `POST /api/grants/request`) plus new collect requests (`need_item`) | 30 per hour, combined | Organisation |
| Email code sends (`POST /api/auth/otp/send`) | 5 per email per 15 minutes | Email address |
| Wrong email codes | 5, then the code is void and a new one must be sent | Challenge |
| OAuth dynamic client registration (`POST /oauth/register`) | 20 per hour | IP address |
| Approval code reuse | A code works once. Reuse is 409, expired is 410 | Code |

## Lifetimes

| What | Lifetime |
| --- | --- |
| Email code | 10 minutes |
| `prompt` approval | Until one successful API call |
| `session` approval | 8 hours |
| `item_standing`, `folder_standing` | Until revoked |
| OAuth access token | 600 seconds. Refresh tokens rotate on use |
| Operator session | Until sign-out or revoke from the Access panel |

## Sizes and timeouts

| What | Cap |
| --- | --- |
| JSON request body on any route | 128 KiB (413 above) |
| Credential name | 128 characters, `[A-Z][A-Z0-9_]{0,127}` |
| `task_description` shown in the Inbox | 500 characters (longer text is truncated) |
| Origin response returned to the agent | 256 KiB |
| Origin call timeout | 10 seconds |
| Access ledger read (`GET /api/access/events`) | 200 newest rows |

## What an agent should do on 429

Tell the operator and stop retrying for the hour. Repeated `request_grant` calls for the same credential do not help; one pending approval is enough and the operator can approve it from the Inbox at any time.
