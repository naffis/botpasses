---
title: Connect Grok
label: Grok
description: Connect Grok Bot with the /mcp URL and complete Authorize in the browser, or put a one-time model token on the connector. Grok Build uses grok mcp add.
section: connect
order: 5
---

Grok Bot can connect with interactive OAuth (Authorize opens a browser on botpasses.com) or with a console-issued **model token** (`avm_...`). Use OAuth when the host shows a connect card. Use the token when you want to skip the card.

## 1a. Grok Bot with OAuth (Authorize)

1. Add a custom connector with Server URL `https://botpasses.com/mcp` and no Authorization header.
2. Click **Authorize**. The host should open a browser to botpasses.com.
3. Sign in, Allow the client, and wait for the redirect back (`https://www.cursor.com/agents/mcp/oauth/callback`, or `grokbot://` / `http://localhost` on a desktop host).
4. The connector should show tools. Ask in plain language ("get my Spotify profile"). Approve in the Inbox if asked.

If Authorize spins and falls back to Retry with no browser, remove the connector and add it again after this origin is on a build that 401s unauthenticated `initialize`. A 200 handshake leaves the host with no auth URL.

After the connector is on, paste a [hosted bootstrap prompt](/docs/prompts#hosted) so Grok walks Collect and Connect. You type secrets on botpasses.com, never in chat. If `tools/call` fails with `redirect_uri`, paste the [Grok redirect_uri prompt](/docs/prompts#grok-redirect_uri).

## 1b. Grok Bot with a model token

1. Open the [console](/console) **Access** panel.
2. Choose **Issue token**, give the agent a name (for example `grok`), and pick its environment.
3. Copy the token. It is shown once. The Access list keeps only the last four characters. If you lose it, **Rotate** issues a new one.
4. Server URL: `https://botpasses.com/mcp`
5. Header: `Authorization: Bearer avm_...` (Grok adds the `Bearer` scheme if you enter only the token)

Save the connector. The header is enough: `initialize`, `tools/list`, and `http_request` all work without a connect card. Put the `avm_` token in the client's secret or env field, not in chat.

Grok Bot runs in a cloud VM, so a local stdio server is not reachable. Use the remote URL.

## 2. Grok Build (CLI)

```bash
export BOTPASSES_MODEL_TOKEN=avm_...
grok mcp add --transport http botpasses https://botpasses.com/mcp \
  --header "Authorization: Bearer ${BOTPASSES_MODEL_TOKEN}"
```

Then paste a [hosted bootstrap prompt](/docs/prompts#hosted). Keep the token in the env field, not in chat.

## What not to paste

Do not paste an operator session, an OAuth client secret, or any API key into Grok. The model token and the OAuth access token stay in the host. The model can list names, request approvals, and call `http_request`.

## Spotify and other OAuth apps

Client secrets, token minting, and user connect are covered in [Use an OAuth client secret](/docs/how-to/use-an-oauth-client-secret).

## Revoke

Revoke the Grok agent in the console **Access** panel. The next call is 401.
