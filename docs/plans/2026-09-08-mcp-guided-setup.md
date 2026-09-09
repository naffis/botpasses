# MCP guided setup (BOTP-10)

Buildable twin of the 2026-09-08 plan. Ticket: BOTP-10.

## Problem

MCP was runtime-only (`http_request`, `find_items`). A miss created a generic need (`API_SPOTIFY_COM`, kind `secret`, inject `bearer`, one host). Collect stored the wrong shape for known providers. There was no first-class “set up X” path.

## Outcome

Sixth MCP tool `setup` (hosted + local, same name) plus sibling **setup recipes** (not the OAuth `PROVIDERS` table). Reuse `ensureNeedItem`, Collect, `ensureConnectNeed`, `next.for_model`. Protocol stays `2024-11-05`. No form elicitation. No vault-side `/spotify/i` matching. The model maps NL to the `provider` enum.

Hard invariant: no secret values in MCP results, chat, logs, Collect HTML, or inbox. Path-only `collect_url` / `connect_url` (no HMAC).

## External research (2026-09-08)

- MCP elicitation (2026-07-28): servers MUST use URL mode for API keys; MUST NOT use form mode for secrets.
- WorkOS / Dreaming Press on URL-mode elicitation: third-party auth in a browser; clients may not implement the RPC.
- Nango / Pipedream: operator pastes the app secret on the platform, user Connect in a browser, agent holds a connection id.
- In-repo 2026-08-30 plan already rejected form elicitation and a protocol bump.
- Claude Code issue 69555 (2026): advertised URL-mode capability dropped (`elicitation/create` `mode: "url"` is `-32602`).
- Official GitHub MCP prefers OAuth with a baked-in app Botpasses does not ship; Slack-hosted MCP is a different product.

Adopt the URL-mode *pattern* (path-only Botpasses URLs in tool JSON). Reject a protocol bump this change.

## Locked decisions

- **D-01.** New `setup` tool, not an overload of `find_items` / `http_request`.
- **D-02.** Sibling recipes in `src/hosted/providers/setup-recipes.ts`. Stripe here is a secret key (`sk_`), not Connect. GitHub is a PAT. Slack is a bot/user token.
- **D-03.** Stay on `2024-11-05`. Deliver URLs in tool content.
- **D-04.** Collect Always-allow checkbox, default unchecked. `always_allow === true` only.
- **D-05.** No create-agent tool. MCP connect stays docs + Agents card.
- **D-06.** Recipe misses store `need.host = primaryHost` so `accounts.spotify.com` and `api.spotify.com` reuse one need.

Recipes: Spotify (`SPOTIFY_SECRET`, client_secret, both hosts, Connect after), Stripe (`STRIPE_SECRET_KEY`, bearer), GitHub (`GITHUB_TOKEN`), Google (`GOOGLE_CLIENT_SECRET`, Connect after), Slack (`SLACK_BOT_TOKEN`).

## Setup states

Idempotent: find items on any recipe host (exclude `*_REFRESH` / inject `refresh`).

- miss → `need_item` + `collect_url` (unless `dry_run`)
- item exists, `connect_after`, no `<ITEM>_REFRESH` → `user_connect_required`
- standing grant (+ connect if required) → `ready`
- item exists, connect ok/not required, only prompt grant → `ready_prompt` (Inbox Always-allow; no second Collect URL)
- multiple non-refresh matches → `ambiguous`

Hosted `need_item` / `ready` / `ready_prompt` / `user_connect_required` are not `isError`. Local `need_item` remains `isError`. Local miss is a `vault set` command (no `--kind`).

## Non-goals

Returning secret values, form elicitation, protocol bump, create-agent over MCP, dashboard autofill, vault-side semantic matching, Stripe Connect as the Stripe recipe, email collect links, a 900-provider catalog.
