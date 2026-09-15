---
title: FAQ
description: What Botpasses is, how it differs from a password manager, .env keys, and Composio, plus prompt injection, logs, revoke, staging, and whether staff can read keys.
section: help
order: 2
---

## What is Botpasses?

Botpasses stores API keys and lets your agents use them with your approval. It attaches the key to each approved API call and removes secrets from the response. The model does not get the key. There is no `get_secret` tool.

## Is this a password manager?

No. Password managers hold secrets for people and fill them into browsers. Botpasses holds credentials for agents and attaches them to API calls the agent asks for. There is no browser autofill, no sharing with other people, and no way to read a value back out. If you need a value on your screen, use a password manager; if you need an agent to call an API without ever holding the key, use Botpasses.

## What if the agent is prompt-injected?

The agent still cannot read a value, because no tool returns one. What it can do is call APIs it has an approval for. Limit that: use `prompt` approvals (one call each) for anything sensitive, keep allowed hosts tight, and revoke standing approvals when a task is done. Each API call is in the Access activity log by agent name and credential name.

## What do you log?

Actions and names: which agent requested or used which credential, when, and the outcome. Tokens are stored as hashes. Secret values are never written to the audit log, the Inbox, emails, error reports, or server logs. The API you call sees the request as normal.

## How do I revoke?

Console **Access** panel. Revoke an agent (its tokens stop working on the next call), a single approval, or a session. See [Revoke access](/docs/how-to/revoke-access). There is no revoke over MCP, so a model cannot undo your revoke or approve itself.

## What is the difference between staging and production?

Inside your account, each credential has an **environment** tag (`staging` or `production`) and each agent is bound to one of them; an agent only sees credentials in its own environment. Separately, `staging.botpasses.com` is the pre-release copy of the service with its own accounts and database; use `botpasses.com` unless you are testing the service itself. The laptop hosted kernel (`npm run hosted:dev`) is a third deploy plane. It is not a Fly app and it is refused when `FLY_APP_NAME` is set.

## Can Botpasses staff read my keys?

Anyone with both the AWS KMS role and the database can decrypt your keys. The hosted process decrypts them in memory when making approved calls. Staff have no support tool that reveals a key. Botpasses is not zero-knowledge. See the [Security](/security) page.

## What does it cost?

Botpasses is free to use and open source under the MIT license. Use [botpasses.com](/sign-up), [self-host](/docs/self-hosting) with Postgres 16 and your own domain, or run it on your laptop with `npm run hosted:dev`.

## Which agents work?

Claude (web, desktop, and Claude Code), Cursor, ChatGPT, Grok, and any MCP client that supports remote servers over HTTP. See [Connect an agent](/docs#list-connect).

## How is this different from putting keys in .env or the system prompt?

A key pasted into a prompt enters the conversation. A key in `.env` can be exposed if an agent reads the file or prints its environment. Botpasses does not return the stored key to the model. It checks the agent’s approval and attaches the key to the API request.

## How is this different from Composio or Arcade?

Those products give the agent a catalog of tools and hold the tokens themselves. With Botpasses, you store the credential and the agent calls MCP `http_request`. Botpasses attaches the key after checking your approval. We do not wrap Stripe or GitHub as first-party tools.

## Where is the source?

[github.com/naffis/botpasses](https://github.com/naffis/botpasses). Design decisions are in the `docs/adr` folder.

## Can I run Botpasses on my laptop?

Yes. Choose a local console or a CLI vault:

- **Hosted kernel on loopback.** From a clone, `npm run hosted:dev` starts the same console, email codes (printed in the terminal), and MCP as botpasses.com, on `http://127.0.0.1:8788`. Connect MCP to `http://127.0.0.1:8788/mcp`. Provider apps get `http://127.0.0.1:8788/connect/callback`, not port 8888. Run one process per sqlite file.
- **CLI vault.** `vault init` under `VAULT_HOME`, then `vault mcp`. No account. The CLI vault callback stays `http://127.0.0.1:8888/callback`.

Self-hosting a shared plane still needs Postgres 16. See [Install](/docs/install) and [Self-hosting](/docs/self-hosting).
