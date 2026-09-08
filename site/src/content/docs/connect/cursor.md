---
title: Connect Cursor
label: Cursor
description: Add Botpasses to Cursor with a two-line mcp.json entry for the remote server, or run the stdio server against a local vault. OAuth sign-in on botpasses.com.
section: connect
order: 3
---

Cursor reads MCP servers from `mcp.json`. Use the remote URL for the hosted service (recommended), or the stdio command for a local vault.

## Remote server (hosted)

Create or edit `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "botpasses": {
      "url": "https://botpasses.com/mcp"
    }
  }
}
```

Then:

1. Open **Cursor Settings**, then **MCP**. The `botpasses` server appears with a **Needs login** state.
2. Choose it. Cursor discovers botpasses.com as the OAuth authorization server, registers itself, and opens your browser.
3. Sign in on botpasses.com with your email code and authenticator, then allow the connection. Cursor's redirect back uses its `cursor://` scheme or a loopback address; both are accepted.

The server shows its tools once connected. Do not paste an operator token or any key into Cursor.

## Use it

Ask the agent for the task in plain language. It calls `http_request`. Pending approvals show an 8-digit code you approve in the [console](/console) Inbox. A missing credential returns a `collect_url` to open in a browser.

## Stdio (local vault, no account)

```json
{
  "mcpServers": {
    "botpasses": {
      "command": "npx",
      "args": ["vault", "mcp"],
      "env": {
        "VAULT_HOME": "/absolute/path/.botpasses",
        "VAULT_MASTER_KEY": "set-me"
      }
    }
  }
}
```

Run it from the cloned repository until the npm package is published (see [Install](/docs/install)). The local server has the same six tools as hosted, `setup` and `http_request` included; approve an agent with `vault grant --secret NAME --agent AGENT --tool http_request`, where the agent is the name Cursor sends on `initialize`. Values still never reach the model.

## Stdio proxy to the hosted service

If you need stdio but want the hosted vault:

```bash
export VAULT_PUBLIC_URL=https://botpasses.com
npx vault login
export VAULT_USER_JWT=eyJ...
npx vault mcp --user-jwt
```

Cursor's OAuth loopback uses port 8787. Botpasses never binds it; the local product server listens on 8788.

## Revoke

Remove the entry from `mcp.json` to disconnect locally. Revoke the agent in the console **Access** panel to invalidate the tokens Cursor already holds.
