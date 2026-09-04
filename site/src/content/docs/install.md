---
title: Install
description: Use the hosted service at botpasses.com, or run the CLI from the repository until the npm package is published. Requirements and first commands.
section: start
order: 2
---

There are two ways to use Botpasses.

## Hosted (recommended)

Nothing to install. [Create an account](/sign-up) on botpasses.com, then follow [Start](/docs/start). Agents connect to `https://botpasses.com/mcp`.

The hosted service is free while in beta. `staging.botpasses.com` is the pre-release plane. Accounts and data are separate between the two.

## CLI from the repository

The `botpasses` npm package is not published yet. Until it is, run the CLI from a clone.

Requirements: Node.js 22.14 or newer.

```bash
git clone https://github.com/naffis/botpasses.git
cd botpasses
npm install
export VAULT_HOME="$PWD/.botpasses"
npx vault init
```

`vault init` creates the SQLite vault at `$VAULT_HOME` and a master key. The default home when `VAULT_HOME` is unset is `$HOME/.botpasses`. You can also run `npm run vault -- <command>`.

Store and use a credential locally:

```bash
printf '%s' 'sk_test_example_not_real' | npx vault set STRIPE_KEY
npx vault list
npx vault grant --secret STRIPE_KEY --agent invoicer --tool stripe --once
npx vault run --with STRIPE_KEY --agent invoicer --tool stripe -- \
  node -e 'console.log("injected", Boolean(process.env.STRIPE_KEY))'
```

`vault run` **injects** the value into the child process environment. That is the only place the local plane reveals it. See the [CLI reference](/docs/reference/cli).

## Local MCP server (stdio)

Point a desktop MCP client at the local vault:

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

The local server exposes the same five tools as hosted: `list_items`, `find_items`, `request_grant`, `list_grants`, and `http_request`. `http_request` calls an allowlisted API with a stored credential once you approve the agent (`vault grant --secret NAME --agent AGENT --tool http_request`); `vault run` is the other inject path, for a child process. Details: [MCP tools](/docs/reference/mcp-tools#local-mcp-sqlite).

## Hosted MCP over stdio

Some clients only speak stdio. The CLI can proxy hosted MCP over an access token:

```bash
export VAULT_PUBLIC_URL=https://botpasses.com
npx vault login
export VAULT_USER_JWT=eyJ...
npx vault mcp --user-jwt
```

`vault login` prints the sign-in, console, and device-login URLs. Device login is RFC 8628: you enter a code on botpasses.com after your authenticator.

## Self-hosting

The hosted process runs on Fly with Neon Postgres. See [Self-hosting](/docs/self-hosting).
