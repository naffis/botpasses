---
title: Start
description: Create a Botpasses account, enroll an authenticator, connect an agent, then ask it to set up a provider or store a credential yourself. About five minutes end to end.
section: start
order: 1
---

Botpasses holds named credentials (API keys, tokens, OAuth client secrets) for AI agents. You are the **operator**: the person who stores credentials and approves their use. An **agent** is a model client such as Claude, Cursor, ChatGPT, or Grok connected over **MCP** (the Model Context Protocol, the standard way those clients call tools). The agent asks to use a credential by name. You approve. Botpasses makes the HTTPS call with the credential attached and returns a redacted result. The agent gets that result, not the key.

## 1. Create an account

1. Open [Create account](/sign-up) on botpasses.com.
2. Enter your email. Botpasses sends an 8-digit code. Enter it on the page.
3. Enroll an authenticator app (TOTP: the six-digit codes that apps like 1Password, Google Authenticator, or Authy generate). Scan the QR code, open the `otpauth://` link, or type the key. Save the backup codes it shows you. Email alone is not enough to operate the vault.

There is no password. Every sign-in is an email code plus your authenticator.

## 2. Connect an agent

Pick the client you use. Each page has the copy-paste config.

- [Claude (web and desktop)](/docs/connect/claude)
- [Claude Code](/docs/connect/claude-code)
- [Cursor](/docs/connect/cursor)
- [ChatGPT](/docs/connect/chatgpt)
- [Grok](/docs/connect/grok)

Any other MCP client that supports remote servers over HTTP works with the URL `https://botpasses.com/mcp` and OAuth sign-in on botpasses.com.

## 3. Set up a credential

Ask the connected agent in plain language: "Set up Spotify so you can call the API for me." The agent calls `setup` and gives you a Botpasses link. Open it, type the Client ID and secret there (never in chat), and check **Always allow this agent to use this credential** if you want that agent to keep using it. For Spotify and Google you then Connect the user account from the Inbox.

You can also store a credential yourself in the [console](/console) (**Credentials** → **Store credential**). Full steps: [Store a credential](/docs/how-to/store-a-secret) and [Guided setup](/docs/how-to/guided-setup).

## 4. Ask for a task and approve it

Ask the agent in plain language: "check my Stripe balance". The agent calls the `http_request` tool. If the credential needs an **approval** (a grant: your permission for one agent to use one credential), the request appears in your console **Inbox**. Approve it there, or type the 8-digit approval code the agent shows you. The agent retries and receives a redacted response.

If nothing is stored for that API, the agent gets a `collect_url`. Open it, sign in, and type the value on botpasses.com. Never paste a secret into chat.

## Local CLI

You can also run Botpasses locally with SQLite and no account. See [Install](/docs/install) and the [CLI reference](/docs/reference/cli).
