---
title: Connect ChatGPT
label: ChatGPT
description: Add Botpasses to ChatGPT as a connector using the remote MCP URL and OAuth. botpasses.com handles registration, sign-in, and consent.
section: connect
order: 4
---

ChatGPT connects to remote MCP servers as **connectors**. Remote MCP in ChatGPT requires OAuth 2.1 with dynamic client registration on the server side, and botpasses.com provides both. You never paste a token into ChatGPT.

Connectors are available on plans that support them; check your workspace settings if the option is missing.

## Add the connector

1. In ChatGPT, open **Settings**, then **Connectors** (developer mode may need to be on for custom connectors).
2. Choose **Create** (or **Add custom connector**).
3. Name: `Botpasses`. MCP server URL: `https://botpasses.com/mcp`. Authentication: **OAuth**. Leave client ID and secret empty; ChatGPT registers itself with botpasses.com.
4. Create, then connect. Sign in on botpasses.com with your email code and authenticator, and allow the connection on the consent page.
5. In a chat, enable the Botpasses connector from the tools menu.

## Use it

Ask for the task in plain language. ChatGPT calls `http_request`; Botpasses attaches the credential and returns a redacted response.

- Pending approval: ChatGPT shows an 8-digit code. Approve in the [console](/console) Inbox or with the code, then retry.
- Missing credential: ChatGPT shows a `collect_url`. Open it, sign in, and type the key on botpasses.com. Never paste it into the chat.

After the connector is on, paste a [hosted bootstrap prompt](/docs/prompts#hosted) so ChatGPT walks Collect and Connect. You type secrets on botpasses.com, never in chat.

## Notes

- Access tokens are short-lived JWTs bound to `https://botpasses.com/mcp`. ChatGPT refreshes them; refresh tokens rotate.
- Each connected agent is bound to one vault environment and only sees credentials in it.
- Revoke ChatGPT from the console **Access** panel. Its tokens stop working on the next call.

The old page at `/docs/connect/openai` redirects here.
