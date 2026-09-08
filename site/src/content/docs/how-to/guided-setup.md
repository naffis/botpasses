---
title: Guided setup
label: Guided setup
description: Connect Botpasses MCP once, then ask an agent to set up Spotify or another API. You type the secret on botpasses.com, never in chat.
section: how-to
order: 2
---

After you [create an account](/docs/start) and [connect an agent](/docs/start), you can ask the agent to set up a provider. The agent does not get the secret.

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

## Connect a user account

Spotify and Google also need a signed-in user for paths such as `/v1/me`. After you store the app secret, the agent gives you a `connect_url` (a console link). Connect the account there. The dialog can also allow that agent to use the connected account.

App-token calls (for example Spotify search) work after store even if you skip Connect.

## Then ask for data

Once setup is `ready`, ask for the data you want: "what's on my Spotify profile?" The agent calls `http_request`. You do not name Botpasses tools.

## Store it yourself

If you prefer not to use `setup`, store the credential in the console. See [Store a credential](/docs/how-to/store-a-secret).
