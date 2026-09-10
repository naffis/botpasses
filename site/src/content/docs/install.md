---
title: Install
description: Use the hosted service at botpasses.com, or run the CLI from the repository until the npm package is published. Requirements and first commands.
section: start
order: 2
---

There are two ways to use Botpasses.

Paste the [local machine prompt](/docs/prompts#local) into an agent on this laptop if you want it to clone the repo, init the vault, and write the MCP snippet. Do not paste the master key into chat.

## Copy-paste prompt

```
Set up a local Botpasses vault on this machine and wire it into my MCP client. Secrets must never enter chat.

Facts:
- Repo: https://github.com/naffis/botpasses (MIT). npm package not published yet; run CLI from a clone.
- Need Node.js 22.14+.
- Local home: set VAULT_HOME to an absolute path (e.g. $PWD/.botpasses or $HOME/.botpasses).
- Local MCP exposes the same six tools as hosted: list_items, find_items, request_grant, list_grants, setup, http_request. Values inject only into approved calls or vault run child env.

Steps:
1. Clone (or reuse) the repo, npm install, export VAULT_HOME to an absolute path, run npx vault init if the vault does not exist. Do not print the master key into chat; tell me where it lives and that I must keep VAULT_MASTER_KEY out of transcripts.
2. Show me the mcp.json snippet for my client (Cursor ~/.cursor/mcp.json or project .cursor/mcp.json) using command npx with args ["vault","mcp"] and env VAULT_HOME + VAULT_MASTER_KEY. I paste or approve the file edit; you do not echo the master key value in the reply.
3. After MCP connects, call list_items to prove the server is up.
4. For the first secret I name (or Stripe test key if I say so), use setup or walk me through: printf '%s' 'THE_SECRET' | npx vault set NAME with me supplying the secret via a secure local path or terminal, never this chat. Then vault grant --secret NAME --agent <name my client sends on initialize> --tool http_request (once or standing as I choose).
5. Smoke http_request to an allowlisted host I approve. Report status only.
6. Point me at https://botpasses.com/docs/install and https://botpasses.com/docs/reference/cli for vault run (child process inject) when I need CLI scripts instead of MCP.

If I already have a hosted account and only need stdio to hosted: use VAULT_PUBLIC_URL=https://botpasses.com, vault login, vault mcp --user-jwt. Still never paste JWTs into chat; use env on the machine.
```

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

The local server exposes the same six tools as hosted: `list_items`, `find_items`, `request_grant`, `list_grants`, `setup`, and `http_request`. `http_request` calls an allowlisted API with a stored credential once you approve the agent (`vault grant --secret NAME --agent AGENT --tool http_request`); `vault run` is the other inject path, for a child process. Details: [MCP tools](/docs/reference/mcp-tools#local-mcp-sqlite).

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
