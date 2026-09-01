# Botpasses cutover (Fly, Cloudflare, Clerk, Resend, GitHub)

Create the Fly apps and copy secrets **before** any `git push origin dev` that contains renamed `fly.staging.toml` / `fly.prod.toml`. Fly deploy tokens are per-app. A missing app or a token that can only deploy `agent-vault-*` surfaces as `Could not find App`.

Do not destroy `agent-vault-staging` / `agent-vault-prod` until `https://staging.botpasses.com/health` and `https://botpasses.com/health` return `{"ok":true,"product":"botpasses"}` through Cloudflare.

GitHub is `naffis/botpasses`. Local origin is `https://github.com/naffis/botpasses.git`. Do not create a new repo named `agent-vault` under the same owner (redirects break).

## DNS and TLS

Orange-cloud (proxied):

| Name | Type | Target |
| --- | --- | --- |
| `botpasses.com` | A | Fly IPv4 of `botpasses-prod` |
| `botpasses.com` | AAAA | Fly IPv6 of `botpasses-prod` |
| `staging.botpasses.com` | A/AAAA or CNAME | `botpasses-staging` (CNAME target from `fly certs setup`) |

Grey-cloud (DNS only):

| Name | Type | Target |
| --- | --- | --- |
| `_fly-ownership.botpasses.com` | TXT | value from `fly certs setup botpasses.com -a botpasses-prod` |
| `_fly-ownership.staging.botpasses.com` | TXT | value from `fly certs setup staging.botpasses.com -a botpasses-staging` |
| `clerk.botpasses.com` | CNAME | Clerk dashboard FAPI value |
| `clerk.staging.botpasses.com` | CNAME | Clerk dashboard FAPI value |
| Resend records for `mail.botpasses.com` | DKIM CNAME, SPF TXT, MX | exactly as Resend shows |
| `_dmarc.botpasses.com` | TXT | `v=DMARC1; p=none` |

Also:

- Cloudflare Redirect Rule: hostname `www.botpasses.com` → `https://botpasses.com/{path}` (preserve query), 301. No Fly cert for `www`.
- SSL/TLS: Full (strict). Always Use HTTPS on. Flexible causes redirect loops with Fly `force_https`.
- Cache Rule: bypass cache for `botpasses.com` and `staging.botpasses.com`.
- WAF: managed rules on. Skip Bot Fight / challenge for `/health` and `/ready`.
- CAA: allow Let's Encrypt and Google Trust Services (Clerk).
- `fly ips list -a botpasses-prod` for apex A/AAAA. Staging uses A/AAAA the same way. Public origins are `botpasses.com` / `staging.botpasses.com` only.
- `fly certs add` per hostname. If ACME stalls, Origin CA covering both hosts, then `fly certs import`.

Clerk CNAME must stay grey-cloud. Orange-cloud fails Clerk's DNS check.

Neon, Sentry, and R2 dashboard display names are cosmetic. Do not create new Neon projects; copy existing `DATABASE_URL` / `DATABASE_URL_DIRECT`. Do not print secret values when copying (`fly secrets list` shows names only).

## Fly

```bash
fly apps create botpasses-staging
fly apps create botpasses-prod
# copy secret names from agent-vault-staging / agent-vault-prod if those apps exist
fly secrets set VAULT_PUBLIC_URL=https://staging.botpasses.com \
  VAULT_EMAIL_FROM='Botpasses <noreply@mail.botpasses.com>' \
  CLERK_FRONTEND_API=clerk.staging.botpasses.com \
  -a botpasses-staging
# reuse existing DATABASE_URL / DATABASE_URL_DIRECT (no new Neon project)
fly certs setup botpasses.com -a botpasses-prod
fly certs setup staging.botpasses.com -a botpasses-staging
```

Confirm GitHub `FLY_API_TOKEN` can deploy the **new** names (org token, or new per-app deploy tokens). Then push `dev`.

Hosted boot exits 78 if `RESEND_API_KEY` is set and `VAULT_EMAIL_FROM` is empty.

## Clerk

Two **production** instances (not satellites). FAPI hosts `clerk.botpasses.com` and `clerk.staging.botpasses.com`, grey-cloud. `CLERK_FRONTEND_API` is the hostname only (code prefixes `https://`). Do not set `authorizedParties` on `verifyToken`.

## Resend

Domain `mail.botpasses.com`. Documented From: `Botpasses <noreply@mail.botpasses.com>`. All Resend records grey-cloud.

## Verify

```bash
curl -fsS https://staging.botpasses.com/health
# {"ok":true,"product":"botpasses"}
curl -fsS https://botpasses.com/health
```

MCP connector URL: `https://botpasses.com/mcp` (prod) or `https://staging.botpasses.com/mcp`.

## Remaining operator checklist

Attempted 2026-08-30 from this checkout. In-repo ACs are green. Live cutover is blocked on credentials. Do not `git push origin dev` with the renamed tomls until Fly apps exist and `FLY_API_TOKEN` can deploy `botpasses-staging` / `botpasses-prod`.

| Step | Status |
| --- | --- |
| `flyctl auth whoami` | **blocked** — `no access token available`. `FLY_API_TOKEN` unset in this environment. Run `flyctl auth login` (or export an org token), then `fly apps create botpasses-staging` and `botpasses-prod`. |
| Copy secrets from `agent-vault-*`; set `VAULT_PUBLIC_URL`, `VAULT_EMAIL_FROM`, `CLERK_FRONTEND_API`; reuse Neon `DATABASE_URL` | **blocked** on Fly auth |
| Confirm GitHub `FLY_API_TOKEN` can deploy the new app names (org token, not a leftover `agent-vault-*` deploy token) | **blocked** on Fly auth. Check in GitHub Actions secrets after apps exist. |
| Cloudflare DNS (A/AAAA, `_fly-ownership` TXT, Clerk/Resend grey-cloud, `www` 301, cache bypass, Full (strict)) | **blocked** — `wrangler whoami` not logged in; `CLOUDFLARE_API_TOKEN` unset. Hosts `botpasses.com` and `staging.botpasses.com` do not resolve. |
| Clerk production instances + FAPI CNAMEs `clerk.botpasses.com` / `clerk.staging.botpasses.com` | **blocked** — no Clerk keys in this environment |
| Resend domain `mail.botpasses.com` verified | **blocked** — `RESEND_API_KEY` unset |
| `git push origin dev` after apps exist | **not run** (no user ask to push; Fly apps do not exist yet) |
| First green staging `/health` through Cloudflare | **blocked** — DNS NXDOMAIN |
| `gh repo rename botpasses` then update git remote | **done** 2026-08-30. Repo is `naffis/botpasses`. Do not create a new `naffis/agent-vault`. |
