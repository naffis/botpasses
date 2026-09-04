---
title: FAQ
description: Short answers. Is Botpasses a password manager, what happens under prompt injection, what is logged, how revoke works, staging vs production, whether staff can read keys.
section: help
order: 2
---

## Is this a password manager?

No. Password managers hold secrets for people and fill them into browsers. Botpasses holds credentials for agents and attaches them to API calls the agent asks for. There is no browser autofill, no sharing with other people, and no way to read a value back out. If you need a value on your screen, use a password manager; if you need an agent to call an API without ever holding the key, use Botpasses.

## What if the agent is prompt-injected?

The agent still cannot read a value, because no tool returns one. What it can do is call APIs it has an approval for. Limit that: use `prompt` approvals (one call each) for anything sensitive, keep allowed hosts tight, and revoke standing approvals when a task is done. Everything the agent does is in the Access activity log by agent name and credential name.

## What do you log?

Actions and names: which agent requested or used which credential, when, and the outcome. Tokens are stored as hashes. Secret values are never written to the audit log, the Inbox, emails, error reports, or server logs. The API you call sees the request as normal.

## How do I revoke?

Console **Access** panel. Revoke an agent (its tokens stop working on the next call), a single approval, or a session. See [Revoke access](/docs/how-to/revoke-access). There is no revoke over MCP, so a model cannot undo your revoke or approve itself.

## What is the difference between staging and production?

Two things share those words. Inside your account, each credential has an **environment** tag (`staging` or `production`) and each agent is bound to one of them; an agent only sees credentials in its own environment. Separately, `staging.botpasses.com` is the pre-release copy of the service with its own accounts and database; use `botpasses.com` unless you are testing the service itself.

## Can Botpasses staff read my keys?

Not without both the AWS KMS role and the database. The hosted process decrypts a value only at inject, inside memory, to attach it to your API call. There is no support tool that reveals a value. Botpasses is a grant-vault, not zero-knowledge; the honest version of this answer is on the [Security](/security) page.

## What does it cost?

Free while in beta. The software is MIT licensed and you can [self-host](/docs/self-hosting).

## Which agents work?

Claude (web, desktop, and Claude Code), Cursor, ChatGPT, Grok, and any MCP client that supports remote servers over HTTP. See [Connect an agent](/docs#list-connect).

## Where is the source?

[github.com/naffis/botpasses](https://github.com/naffis/botpasses). Design decisions are in the `docs/adr` folder.
