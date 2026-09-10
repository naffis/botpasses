---
title: Connect Grok
label: Grok
description: Connect Grok Bot with the /mcp URL and a one-time model token from the console, or add Botpasses to Grok Build with grok mcp add. No OAuth card needed.
section: connect
order: 5
---

Grok connects with a bearer token instead of OAuth. Issue a **model token** (`avm_...`) from the console once, and Grok sends it as `Authorization: Bearer` on every call. That header is enough: `initialize`, `tools/list`, and `http_request` all work without a connect card.

## 1. Issue a model token

1. Open the [console](/console) **Access** panel.
2. Choose **Issue token**, give the agent a name (for example `grok`), and pick its environment.
3. Copy the token. It is shown once. The Access list keeps only the last four characters. If you lose it, **Rotate** issues a new one.

## 2a. Grok Bot (custom connector)

Grok Bot runs in a cloud VM, so a local stdio server is not reachable. Use the remote URL.

- Server URL: `https://botpasses.com/mcp`
- Header: `Authorization: Bearer avm_...` (Grok adds the `Bearer` scheme if you enter only the token)

Save the connector. Then ask in plain language ("get my Spotify profile"). Grok calls `http_request` in the same turn. Approve in the Inbox if asked.

## 2b. Grok Build (CLI)

```bash
export BOTPASSES_MODEL_TOKEN=avm_...
grok mcp add --transport http botpasses https://botpasses.com/mcp \
  --header "Authorization: Bearer ${BOTPASSES_MODEL_TOKEN}"
```

## What not to paste

Do not paste an operator session, an OAuth client secret, or any API key into Grok. The model token is the only thing Grok needs, and it cannot read values: it can list names, request approvals, and call `http_request`.

## OAuth connect cards

Grok Bot in the cloud cannot finish OAuth. Registration may accept `http://localhost` or `grokbot://`, but a cloud VM cannot complete a local redirect. Put the model token on the connector and skip the card. If a card still appears after the header is set, see [Troubleshooting](/docs/troubleshooting#the-connect-card-keeps-appearing).

## Spotify and other OAuth apps

Client secrets, token minting, and user connect are covered in [Use an OAuth client secret](/docs/how-to/use-an-oauth-client-secret).

## Revoke

Revoke the `grok` agent in the console **Access** panel. The token returns 401 on the next call.
