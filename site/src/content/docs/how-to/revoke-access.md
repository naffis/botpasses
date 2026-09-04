---
title: Revoke access
description: Stop an agent, a single approval, or a signed-in session from the console Access panel, and read the activity log that never contains values.
section: how-to
order: 3
---

Everything that can hold access is listed in one place: the console **Access** panel. Revoke is operator-only. There is no revoke over MCP.

## What you see

- **Agents** (clients). Each row shows the name, the last four characters of its bearer token, when it was issued, first and last access, and which credential names it has fetched. The full token was shown once at issue time and cannot be shown again. **Rotate** issues a new token and kills the old one.
- **Approvals** (grants). Agent, credential, policy, status.
- **Sessions.** Your own signed-in browsers and CLIs.
- **Activity.** Actions and names only: `request_grant`, `inject`, `token_issued`, and so on. Secret values are never written to the log.

Open **Audit log** on an agent row to see only that agent's activity.

## Revoke

| Action | Effect |
| --- | --- |
| Revoke an agent | Its bearer token and any OAuth access tokens stop working on the next request (401). Every OAuth connection any member of the organisation made for that agent is ended, so a refresh cannot bring it back; only a new sign-in and consent can. Its approvals are revoked. |
| Revoke an approval | That agent can no longer use that credential. Other approvals stay. |
| Revoke a session | That browser or CLI is signed out. You cannot revoke the session you are using; sign out instead. |
| Revoke other sessions | Signs out everything except the current session. |

Every revoke asks you to confirm in a dialog before the request is sent.

## Deleting a credential

Deleting a credential in **Credentials** also ends every approval for it. Rotating a credential keeps approvals and replaces the value.

## By API

`POST /api/clients/:id/revoke`, `POST /api/grants/:id/revoke`, `POST /api/sessions/:id/revoke`, `POST /api/sessions/revoke-others`. Operator session plus `X-CSRF-Token`. See the [HTTP API](/docs/reference/http-api#access).
