---
title: Start
description: Create a Botpasses account, enroll an authenticator, store your first credential, and connect an agent. About five minutes end to end.
section: start
order: 1
---

Botpasses holds named credentials (API keys, tokens, OAuth client secrets) for AI agents. You are the **operator**: the person who stores credentials and approves their use. An **agent** is a model client such as Claude, Cursor, ChatGPT, or Grok connected over **MCP** (the Model Context Protocol, the standard way those clients call tools). The agent asks to use a credential by name. You approve. Botpasses makes the HTTPS call with the credential attached and returns a redacted result. The model never receives the value.

## 1. Create an account

1. Open [Create account](/sign-up) on botpasses.com.
2. Enter your email. Botpasses sends an 8-digit code. Enter it on the page.
3. Enroll an authenticator app (TOTP: the six-digit codes that apps like 1Password, Google Authenticator, or Authy generate). Scan the QR code, open the `otpauth://` link, or type the key. Save the backup codes it shows you. Email alone is not enough to operate the vault.

There is no password. Every sign-in is an email code plus your authenticator.

## 2. Store a credential

Open the [console](/console). In **Vault**, choose **Store credential**. Give it an env-var style name such as `STRIPE_SECRET_KEY`, paste the value, and list the API hostnames it may be sent to (for example `api.stripe.com`). Only those hosts will ever receive it.

Full steps and the options: [Store a credential](/docs/how-to/store-a-secret).

## 3. Connect an agent

Pick the client you use. Each page has the copy-paste config.

- [Claude (web and desktop)](/docs/connect/claude)
- [Claude Code](/docs/connect/claude-code)
- [Cursor](/docs/connect/cursor)
- [ChatGPT](/docs/connect/chatgpt)
- [Grok](/docs/connect/grok)

Any other MCP client that supports remote servers over HTTP works with the URL `https://botpasses.com/mcp` and OAuth sign-in on botpasses.com.

## 4. Ask for a task and approve it

Ask the agent in plain language: "check my Stripe balance". The agent calls the `http_request` tool. If the credential needs an **approval** (a grant: your permission for one agent to use one credential), the request appears in your console **Inbox**. Approve it there, or type the 8-digit approval code the agent shows you. The agent retries and receives a redacted response.

If nothing is stored for that API, the agent gets a `collect_url`. Open it, sign in, and type the value on botpasses.com. Never paste a secret into chat.

## Local CLI

You can also run Botpasses locally with SQLite and no account. See [Install](/docs/install) and the [CLI reference](/docs/reference/cli).
