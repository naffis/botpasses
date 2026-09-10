---
title: Guided setup
label: Guided setup
description: Connect Botpasses MCP once, then ask an agent to set up Spotify or another API. You type the secret on botpasses.com, never in chat.
section: how-to
order: 2
---

After you [create an account](/docs/start) and [connect an agent](/docs/start), you can ask the agent to set up a provider. The agent does not get the secret.

Or paste a prompt from [Copy-paste prompts](/docs/prompts). The hosted prompt walks the whole flow. The short prompt below is enough when MCP is already connected.

## Copy-paste prompts

Hosted agent (Claude, Cursor, ChatGPT, or Grok after `https://botpasses.com/mcp`):

```
You are setting up Botpasses for me (https://botpasses.com). Botpasses is a grant-vault for agents: I store API credentials once; you call APIs through MCP; the key is attached inside the vault and must never appear in chat, logs, or your context. There is no get_secret.

Do this end to end. Pause and give me a link or checkbox whenever a human step is required. Do not ask me to paste secrets into this chat.

1. Confirm Botpasses MCP is connected.
   - Hosted MCP URL: https://botpasses.com/mcp
   - If tools are missing, tell me which client I am on and open the matching docs:
     Cursor https://botpasses.com/docs/connect/cursor
     Claude https://botpasses.com/docs/connect/claude
     Claude Code https://botpasses.com/docs/connect/claude-code
     ChatGPT https://botpasses.com/docs/connect/chatgpt
     Grok https://botpasses.com/docs/connect/grok
   - Grok often needs a console-issued bearer (avm_…) as Authorization: Bearer <token> (single Bearer, no double Bearer). If tools/call falls into OAuth redirect_uri errors, say so and point me at a one-time model token from the Botpasses console.

2. Call the setup tool for the first API I name (default: Spotify if I do not name one). Prefer provider=spotify|stripe|github|google|slack, or host= for other APIs.

3. When setup returns collect_url, give me that URL only. Tell me to open it, sign in, type the credential there, and never paste the value here. For Client ID and secret kinds, remind me the redirect URI on the provider app is https://botpasses.com/connect/callback.

4. If setup or http_request returns connect_url (user OAuth, e.g. Spotify /v1/me), give me that console link and wait until I confirm Connect is done.

5. Prefer Always-allow only when I say so. Otherwise one-shot Inbox approvals are fine.

6. When status is ready, smoke a read-only call (for Spotify: GET /v1/search or /v1/me after Connect). Report origin status and a short redacted summary. Do not print tokens.

7. Stop with: (a) item name, (b) hosts, (c) whether user Connect is done, (d) one example ask I can type next in plain language.

If anything fails (need_item, host_mismatch, mfa_required, 429, redirect_uri), use https://botpasses.com/docs/troubleshooting and keep secrets out of chat.
```

First API only:

```
Botpasses MCP should already be connected. Call setup for <spotify|stripe|github|google|slack or host=…>. Give me collect_url (and connect_url if needed). I will type secrets on Botpasses only. When ready, run one read-only smoke and tell me the item name and a plain-language ask to use next.
```

## Ask the agent

In the client you connected (Cursor, Claude, ChatGPT, or Grok), say:

> Set up Spotify so you can call the API for me.

Other examples: "store a Stripe secret key", "set up GitHub so you can call the API", "connect Google credentials".

The agent calls the `setup` tool with `provider` (`spotify`, `github`, `google`, `slack`, or `stripe`) or an API `host`. It gives you a Botpasses `collect_url`. Open that page and type the credential there. Do not paste the value into chat.

## What you type on Collect

For a known provider the form is prefilled:

| Provider | Name | What to store |
| --- | --- | --- |
| Spotify | `SPOTIFY_SECRET` | Client ID and Client Secret from [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) |
| Stripe | `STRIPE_SECRET_KEY` | Secret key (`sk_`), not a Stripe Connect OAuth client |
| GitHub | `GITHUB_TOKEN` | Fine-grained personal access token |
| Google | `GOOGLE_CLIENT_SECRET` | OAuth client ID and secret from Google Cloud |
| Slack | `SLACK_BOT_TOKEN` | Bot token (`xoxb-`) or user token (`xoxp-`) |

Check **Always allow this agent to use this credential** if you want that agent to keep using it without a new Inbox card each time. The box starts unchecked.

When Kind is Client ID and secret, Collect shows the redirect URI to add on the app. On production it is `https://botpasses.com/connect/callback`. Same URI for every provider.

## Connect a user account

Spotify and Google also need a signed-in user for paths such as `/v1/me`. After you store the app secret, the agent gives you a `connect_url` (a console link). Connect the account there. The dialog shows the same redirect URI again, and can also allow that agent to use the connected account.

App-token calls (for example Spotify search) work after store even if you skip Connect.

## Then ask for data

Once setup is `ready`, ask for the data you want: "what's on my Spotify profile?" The agent calls `http_request`. You do not name Botpasses tools.

## Store it yourself

If you prefer not to use `setup`, store the credential in the console. See [Store a credential](/docs/how-to/store-a-secret).
