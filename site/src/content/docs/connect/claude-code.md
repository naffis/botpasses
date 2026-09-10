---
title: Connect Claude Code
label: Claude Code
description: Register Botpasses in Claude Code with one claude mcp add command, sign in from the /mcp menu, and call APIs from the terminal without keys in your shell.
section: connect
order: 2
---

Claude Code (the terminal client) connects to Botpasses as a remote MCP server over HTTP with OAuth. Nothing secret goes into your shell history or your project files.

## Add the server

```bash
claude mcp add --transport http botpasses https://botpasses.com/mcp
```

Add `--scope user` to make it available in every project instead of the current one.

## Sign in

1. Start `claude` and run `/mcp`.
2. Pick **botpasses** and choose **Authenticate**. A browser window opens on botpasses.com.
3. Sign in with your email code and authenticator, then allow the connection on the consent page.

Back in the terminal, the server shows as connected. `claude mcp list` prints it as well.

## Use it

Ask for the task: "list my open Stripe disputes". Claude Code calls `http_request` with the host, method, and path. Botpasses attaches the credential and returns a redacted response.

- Pending approval: Claude Code shows an 8-digit code. Approve in the [console](/console) Inbox or type the code under **Approve by code**. Then let it retry.
- Missing credential: it shows a `collect_url`. Open it in a browser, sign in, and store the key there. Never paste a key into the terminal chat.

After MCP is connected, paste a [hosted bootstrap prompt](/docs/prompts#hosted) so the agent walks Collect and Connect. You type secrets on the Botpasses plane you connected, never in chat. For a laptop CLI vault, use the [local prompt](/docs/prompts#local). The laptop hosted kernel is `npm run hosted:dev` at `http://127.0.0.1:8788/mcp`; provider apps get `http://127.0.0.1:8788/connect/callback`. See [Install](/docs/install).

## Team projects

You can commit a project-scoped server entry in `.mcp.json` at the repo root. Each person authenticates on their own account; the file holds only the URL.

```json
{
  "mcpServers": {
    "botpasses": {
      "type": "http",
      "url": "https://botpasses.com/mcp"
    }
  }
}
```

## Remove or revoke

`claude mcp remove botpasses` removes the local entry. To stop the tokens it already holds, revoke the agent in the console **Access** panel.

## Local vault instead

If you want a local SQLite vault with no account, register the stdio server from [Install](/docs/install#local-mcp-server-stdio). It has the same six tools, `setup` and `http_request` included; approvals come from `vault grant --secret NAME --agent AGENT --tool http_request` or the local console instead of the hosted Inbox. The laptop hosted kernel (`npm run hosted:dev`) is a different process: point Claude Code at `http://127.0.0.1:8788/mcp`.
