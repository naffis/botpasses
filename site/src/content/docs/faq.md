---
title: FAQ
description: What Botpasses is, how it differs from a password manager, .env keys, and Composio, plus prompt injection, logs, revoke, staging, and whether staff can read keys.
section: help
order: 2
---

## What is Botpasses?

Botpasses is a grant-vault for AI agents. You store an API key once. An agent asks to call an API. You approve. Botpasses attaches the key inside the vault, makes the call, and returns a redacted result. The model does not get the key. There is no `get_secret`.

## Is this a password manager?

No. Password managers hold secrets for people and fill them into browsers. Botpasses holds credentials for agents and attaches them to API calls the agent asks for. There is no browser autofill, no sharing with other people, and no way to read a value back out. If you need a value on your screen, use a password manager; if you need an agent to call an API without ever holding the key, use Botpasses.

## What if the agent is prompt-injected?

The agent still cannot read a value, because no tool returns one. What it can do is call APIs it has an approval for. Limit that: use `prompt` approvals (one call each) for anything sensitive, keep allowed hosts tight, and revoke standing approvals when a task is done. Everything the agent does is in the Access activity log by agent name and credential name.

## What do you log?

Actions and names: which agent requested or used which credential, when, and the outcome. Tokens are stored as hashes. Secret values are never written to the audit log, the Inbox, emails, error reports, or server logs. The API you call sees the request as normal.

## How do I revoke?

Console **Access** panel. Revoke an agent (its tokens stop working on the next call), a single approval, or a session. See [Revoke access](/docs/how-to/revoke-access). There is no revoke over MCP, so a model cannot undo your revoke or approve itself.

## What is the difference between staging and production?

Two things share those words. Inside your account, each credential has an **environment** tag (`staging` or `production`) and each agent is bound to one of them; an agent only sees credentials in its own environment. Separately, `staging.botpasses.com` is the pre-release copy of the service with its own accounts and database; use `botpasses.com` unless you are testing the service itself. The laptop hosted kernel (`npm run hosted:dev`) is a third deploy plane. It is not a Fly app and it is refused when `FLY_APP_NAME` is set.

## Can Botpasses staff read my keys?

Not without both the AWS KMS role and the database. The hosted process decrypts a value only at inject, inside memory, to attach it to your API call. There is no support tool that reveals a value. Botpasses is a grant-vault, not zero-knowledge; the honest version of this answer is on the [Security](/security) page.

## What does it cost?

Free while in beta. The software is MIT licensed. [Self-host](/docs/self-hosting) on any Postgres 16 and an `https` origin you control, or run `npm run hosted:dev` on a laptop.

## Which agents work?

Claude (web, desktop, and Claude Code), Cursor, ChatGPT, Grok, and any MCP client that supports remote servers over HTTP. See [Connect an agent](/docs#list-connect).

## How is this different from putting keys in .env or the system prompt?

A key in `.env` or a prompt is visible to the model, the transcript, and anyone who can read the chat or the repo. Botpasses never returns a value to the model. The agent asks for a call by host; you approve; the vault attaches the key on the way out.

## How is this different from Composio or Arcade?

Those products give the agent a catalog of tools and hold the tokens themselves. Botpasses is the opposite shape: you keep the credential, the agent keeps MCP `http_request`, and Botpasses attaches the key only after you approve. We do not wrap Stripe or GitHub as first-party tools.

## Where is the source?

[github.com/naffis/botpasses](https://github.com/naffis/botpasses). Design decisions are in the `docs/adr` folder.

## Can I run Botpasses on my laptop?

Yes. Two paths, and they are not the same process.

- **Hosted kernel on loopback.** From a clone, `npm run hosted:dev` starts the same console, email codes (printed in the terminal), and MCP as botpasses.com, on `http://127.0.0.1:8788`. Connect MCP to `http://127.0.0.1:8788/mcp`. Provider apps get `http://127.0.0.1:8788/connect/callback`, not port 8888. Run one process per sqlite file.
- **CLI vault.** `vault init` under `VAULT_HOME`, then `vault mcp`. No account. The CLI vault callback stays `http://127.0.0.1:8888/callback`.

Self-hosting a shared plane still needs Postgres 16. See [Install](/docs/install) and [Self-hosting](/docs/self-hosting).
