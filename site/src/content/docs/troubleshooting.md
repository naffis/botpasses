---
title: Troubleshooting
description: Fixes for host_mismatch, mfa_required, a connect card that keeps appearing, 409 on a reused approval code, need_item and collect_url, and 429 rate limits.
section: help
order: 1
---

## host_mismatch

**What you see.** The tool result is an MCP error with `status: "host_mismatch"`. The agent named a credential (`item_name`) that is not allowed for the host it called.

**Fix.** Either let the agent call by host only (drop `item_name` so Botpasses picks the right credential), or add the host to the credential's **Allowed hosts** in the console (Vault, Edit). Allowed hosts are exact hostnames, so `api.stripe.com` does not cover `files.stripe.com`.

## mfa_required

**What you see.** `403 { "error": "mfa_required", "enroll_url": "/enroll-totp" }` from an operator route, or the console sends you to `/enroll-totp`.

**Why.** Your session verified an email code but has not completed the authenticator step. Operator actions need both.

**Fix.** Open [/enroll-totp](/enroll-totp) and finish enrollment, or sign in again and enter your authenticator code when asked. Agents never see this error; it is operator-only.

## The connect card keeps appearing

**Grok with a model token.** The `Authorization: Bearer avm_...` header is enough. `initialize` and `tools/list` succeed without OAuth. Grok Bot in the cloud cannot finish an OAuth card (its callback is `http://localhost` or a local app scheme). Skip the card. If vault calls still fail, the header is missing, revoked, or rotated (Access shows the last four characters).

**OAuth clients (Claude, Cursor, ChatGPT).** A card that returns after every session usually means the client could not finish dynamic client registration or the redirect back. Botpasses accepts `https`, RFC 8252 loopback `http` (`127.0.0.1`, `[::1]`, `localhost`), and desktop schemes such as `cursor://` and `grokbot://`. It rejects `javascript:`, `data:`, and `file:`. Remove the server entry in the client, add it again, and complete the browser sign-in on botpasses.com in one go. If the agent was revoked in the Access panel, the client must connect again; that is expected.

## 409 on an approval code

**What you see.** `409` from `POST /api/grants/approve-by-code`, or "code already used" in the console.

**Why.** An 8-digit approval code works once. If the agent asked twice, the second request has its own code and the first is void.

**Fix.** Use the newest code the agent showed, or approve the card in the Inbox instead. After a *failed* API call the agent does not need a new code: a `prompt` approval survives 401, 410, and 5xx responses, and the agent should retry with `next.arguments`. An expired code is 410; ask the agent again.

## need_item and collect_url

**What you see.** The agent says nothing is stored for that API and gives you a `collect_url` such as `https://botpasses.com/collect/need_...`. The Inbox shows *Store the credential*.

**Fix.** Open the URL (or the Inbox card), sign in, and type the value on botpasses.com. Botpasses stores it with the suggested name and host and gives the requesting agent a one-time approval. Tell the agent to retry. Never paste the value into the chat; the model does not need it and Botpasses never asks for it there.

If you already stored the credential and still get `need_item`, the agent is probably in a different environment (`staging` vs `production`) or the stored allowed host does not match the host the agent called.

## 429 rate limit

**What you see.** `429` from `POST /api/grants/request` or `POST /api/auth/otp/send`, or a tool error saying the limit was reached.

**Why.** 30 new approval and collect requests per organisation per hour; 5 email codes per address per 15 minutes; 20 OAuth registrations per IP per hour. Full list: [Rate limits](/docs/reference/rate-limits).

**Fix.** Wait for the window. Approve the pending request that already exists instead of asking the agent to request again.

## The agent asks me to paste the key

Botpasses never asks for a value in chat and tells the model not to. If an agent asks anyway, refuse, and use the `collect_url` or the console instead. Consider revoking that agent from the Access panel if it keeps asking.

## Still stuck

Email [support@botpasses.com](mailto:support@botpasses.com) with the tool result (it never contains a value) and the time of the call. Security issues go to [security@botpasses.com](mailto:security@botpasses.com); see [Security disclosure](/docs/security/disclosure).
