---
title: Store a credential
label: Store a credential
description: Store an API key or OAuth client secret in the Botpasses console, choose how it is sent, and restrict the hosts that may receive it.
section: how-to
order: 1
---

A **credential** is the stored thing: an API key, a token, or an OAuth client secret. It has a name, a value, a kind, an environment, and a list of allowed hosts. The value is encrypted at rest and never shown again after you submit it.

## In the console

1. [Sign in](/sign-in) and open the [console](/console).
2. In **Credentials**, choose **Store credential**.
3. **Name.** Env-var style: `STRIPE_SECRET_KEY`. Uppercase letters, digits, and underscores, starting with a letter (`[A-Z][A-Z0-9_]{0,127}`). Names are unique per environment.
4. **Kind.** *API token* sends the value as `Authorization: Bearer`. *Client ID and secret* is an OAuth app secret; enter the public Client ID as well. It is stored as `client_secret` and Botpasses mints app tokens with it instead of sending it as a Bearer. See [Use an OAuth client secret](/docs/how-to/use-an-oauth-client-secret).
5. **Allowed hosts.** The HTTPS hostnames the agent may call with this credential, such as `api.stripe.com`. Hostnames only, not URLs. Only these hosts will ever receive the value.
6. **Environment.** `staging` or `production`. Agents are bound to one environment and only see credentials in it. On `staging.botpasses.com` the only choice is staging.
7. **Change how it is sent** (optional). Bearer is the default for API tokens. Choose HTTP Basic (with a username) or a raw header (`header:X-Api-Key`) when the API needs it.
8. **Store.** If the request is rejected, the dialog stays open and shows the error. The value field keeps what you typed.

## Edit, rotate, delete

- **Edit** opens the same form prefilled. Leave the value blank to keep the current secret.
- **Rotate** replaces the value only.
- **Delete** removes the credential. Agents with an approval for it lose access at once.

## When an agent asked first

If you asked the agent to set up a provider, follow [Guided setup](/docs/how-to/guided-setup). If an agent called an API and nothing was stored for that host, the tool result carries a `collect_url` and the request appears in your **Inbox** as *Store the credential*. Either open the Inbox card or the `collect_url`, sign in, and type the value on botpasses.com. For a known API the form is prefilled (name, kind, hosts). Check **Always allow this agent to use this credential** if you want a standing approval. Left unchecked, Botpasses gives the requesting agent a one-time approval so its retry succeeds.

Never paste a secret into the chat. The model does not need it and Botpasses never asks for it there.

## Local CLI

```bash
printf '%s' 'sk_test_example_not_real' | npx vault set STRIPE_KEY
```

The output is the name and the last four characters, never the value.

## API

`POST /api/items` with an operator session and `X-CSRF-Token`. Fields: `name`, `value`, `environment`, `kind`, `allowed_hosts`, `inject`, optional `username` and `folder_name`. See the [HTTP API](/docs/reference/http-api#items-and-collect). The MCP side of a miss is `need_item` plus `collect_url` in the [MCP reference](/docs/reference/mcp-tools#find_items).
