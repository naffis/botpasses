---
title: Connect Claude
label: Claude
description: Add Botpasses to Claude on the web or Claude Desktop as a custom connector, sign in on botpasses.com, and let Claude call APIs without seeing the keys.
section: connect
order: 1
---

Claude connects to Botpasses as a remote MCP server with OAuth. botpasses.com is the authorization server, so sign-in and consent happen on botpasses.com, not on a third-party identity host. You never paste a token into Claude.

For the terminal client, see [Connect Claude Code](/docs/connect/claude-code).

## Add the connector

1. In Claude, open **Settings**, then **Connectors**.
2. Choose **Add custom connector**.
3. Name: `Botpasses`. Remote MCP server URL: `https://botpasses.com/mcp`. Leave the OAuth client fields empty; Claude registers itself with botpasses.com (dynamic client registration) and uses PKCE.
4. Save, then choose **Connect**. A browser window opens on botpasses.com. Sign in with your email code and authenticator, then allow the connection on the consent page. The page names the client and where it will send you back.
5. In a new chat, open the tools menu and make sure the Botpasses connector is enabled.

Claude Desktop uses the same Settings > Connectors screen and syncs with the web.

## Use it

Ask for the task in plain language: "check my Stripe balance" or "get my Spotify profile". The server tells Claude to call `http_request` in the same turn, so you do not need to mention Botpasses or name a tool.

- If the credential needs your approval, Claude shows an 8-digit code and asks you to approve in the [console](/console) Inbox or with the code. Approve, then tell Claude to retry (or it retries on its own).
- If nothing is stored for that API, Claude gives you a `collect_url`. Open it, sign in, and type the key on botpasses.com. Do not paste it into the chat.

## What Claude can and cannot do

Claude sees credential names, the last four characters, approval status, and redacted API responses. It cannot read a value, and there is no tool that returns one. Revoke Claude at any time from the console **Access** panel; its tokens stop working on the next call.

## Environments

Each connected agent is bound to one vault environment (`staging` or `production`) and only sees credentials in it. If Claude cannot find a credential you stored, check that both are in the same environment.

## If the connect card keeps appearing

See [Troubleshooting](/docs/troubleshooting#the-connect-card-keeps-appearing).
