---
title: Use an OAuth client secret
label: OAuth client secret
description: Store an OAuth app's client secret so Botpasses mints app tokens for you, and connect a user account when an API needs a user token. Spotify walkthrough.
section: how-to
order: 4
---

An OAuth **client secret** is the password of an app, not of a user. It must never be sent as `Authorization: Bearer` to a resource API. Botpasses stores it as kind `client_secret` and handles the token exchange itself. Spotify is the worked example; the same shape applies to other OAuth 2 client-credentials APIs that Botpasses supports.

## Store the client secret

1. In the console, **Store credential**. Kind: **Client ID and secret**. Enter the public Client ID and the Client Secret.
2. Allowed hosts: `api.spotify.com, accounts.spotify.com` (the resource host and the token host).
3. Store. The value is kept as `client_secret`, and the vault row shows *app secret*, not *token*.

## What Botpasses does on a call

When an agent calls `http_request` against `api.spotify.com` with this credential:

1. Botpasses sends `POST https://accounts.spotify.com/api/token` with HTTP Basic (`client_id:client_secret`) and a form body `grant_type=client_credentials`. JSON plus a Bearer of the secret is invalid at that endpoint, so Botpasses never does that.
2. It caches the minted app token for its lifetime.
3. It calls `api.spotify.com` with `Authorization: Bearer <app token>`.
4. Any access token in the response is replaced with `[redacted]` before the result reaches the model.

The agent can also pass a public `client_id` argument on `http_request` if the credential was stored without one.

## App token or user token

An app token can call endpoints that are not about a person, for example `GET /v1/search`. Endpoints about the signed-in user, such as `GET /v1/me` or private playlist writes, need a **user token** obtained with Authorization Code and PKCE.

When an agent hits one of those with an app token, the tool result says so instead of failing silently. To fix it:

1. Open the credential in **Credentials** and choose **Connect Spotify account**.
2. Add the redirect URI to your Spotify app: `https://botpasses.com/integrations/spotify/callback` (or `http://127.0.0.1:8888/callback` for a local setup).
3. Approve in the Spotify consent screen. Botpasses stores the refresh token in the vault as `SPOTIFY_REFRESH` (next to `SPOTIFY_SECRET`) and uses it on later calls. The refresh token and the access tokens stay out of the model.

## Refresh through the token endpoint directly

An agent that holds an approval on `SPOTIFY_REFRESH` alone can also call the token endpoint itself: `http_request` with `item_name: SPOTIFY_REFRESH`, `POST https://accounts.spotify.com/api/token`, and a body of `grant_type=refresh_token` (or no body). Botpasses finds the client secret in `SPOTIFY_SECRET` (or `SPOTIFY`) in the same environment, sends it the way the provider expects (HTTP Basic for Spotify and Slack, `client_id` and `client_secret` form fields for Google, GitHub, and Stripe Connect) with the refresh token in the form, and returns the token body with every token replaced by `[redacted]`, plus `refreshed: true` and `token_last4`. The agent never needs an approval on the client secret item, and neither value reaches the result. Both items must list the token host in their allowed hosts. If the client secret item is missing, a provider that refuses public clients (Slack, GitHub, Stripe Connect) gets a clear `inject_denied` result naming the item to store instead of a vendor `invalid_client`; Spotify and Google, which support PKCE, are sent the public-client exchange with `client_id` only.

## Retry after a failed call

A `prompt` approval is spent by any answer from Spotify, including a 401 or 410, because the client secret was already sent. If the agent retries and gets a pending grant, approve it again, or approve with limits (a call quota or a duration) so a token mint that fails once can be retried without a new code. If Spotify rotates the refresh token on a user-token call, Botpasses stores the new one in place.

## Related

- [MCP tools](/docs/reference/mcp-tools#http_request): `client_id` and `content_type` arguments.
- [HTTP API](/docs/reference/http-api#items-and-collect): `POST /api/integrations/spotify/start` and the callback route.
