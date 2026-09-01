# Botpasses cutover (Fly, Cloudflare, Resend, GitHub)

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
| Resend records for `botpasses.com` and `staging.botpasses.com` | DKIM CNAME (`resend._domainkey` / `resend._domainkey.staging`), SPF (`send` / `send.staging`) | grey-cloud, exactly as Resend shows |
| `_dmarc.botpasses.com` | TXT | `v=DMARC1; p=none` |

Also:

- Cloudflare Redirect Rule: hostname `www.botpasses.com` → `https://botpasses.com/{path}` (preserve query), 301. No Fly cert for `www`.
- SSL/TLS: Full (strict). Always Use HTTPS on. Flexible causes redirect loops with Fly `force_https`.
- Cache Rule: bypass cache for `botpasses.com` and `staging.botpasses.com`.
- WAF: managed rules on. Skip Bot Fight / challenge for `/health` and `/ready`.
- CAA: allow Let's Encrypt.
- Delete leftover `clerk.*` CNAMEs after this SHA is live. Do not run Clerk and this origin's AS at the same time.
- `fly ips list -a botpasses-prod` for apex A/AAAA. Staging uses A/AAAA the same way. Public origins are `botpasses.com` / `staging.botpasses.com` only.
- `fly certs add` per hostname. If ACME stalls, Origin CA covering both hosts, then `fly certs import`.

Do not add `clerk.*` CNAMEs.

Neon, Sentry, and R2 dashboard display names are cosmetic. Do not create new Neon projects; copy existing `DATABASE_URL` / `DATABASE_URL_DIRECT`. Do not print secret values when copying (`fly secrets list` shows names only).

## Fly

```bash
fly apps create botpasses-staging
fly apps create botpasses-prod
# copy secret names from agent-vault-staging / agent-vault-prod if those apps exist
fly secrets set VAULT_PUBLIC_URL=https://staging.botpasses.com \
  VAULT_EMAIL_FROM='Botpasses <noreply@staging.botpasses.com>' \
  VAULT_SESSION_SECRET='<32+ bytes>' \
  VAULT_OIDC_PRIVATE_JWK='<RS256 private JWK JSON>' \
  -a botpasses-staging
# then unset leftover Clerk secrets on both apps
# reuse existing DATABASE_URL / DATABASE_URL_DIRECT (no new Neon project)
fly certs setup botpasses.com -a botpasses-prod
fly certs setup staging.botpasses.com -a botpasses-staging
```

Confirm GitHub `FLY_API_TOKEN` can deploy the **new** names (org token, or new per-app deploy tokens). Then push `dev`.

Hosted boot exits 78 if `RESEND_API_KEY` is set and `VAULT_EMAIL_FROM` is empty.

## KMS wrap (after this image is live)

Do not set `VAULT_KEK_REQUIRE_KMS=1` until wrap is confirmed on that plane. Raw `VAULT_KEK` still boots when the flag is unset.

| Secret | When |
| --- | --- |
| `VAULT_KEK` | Pre-cutover fallback. Unset after `VAULT_KEK_REQUIRE_KMS=1` is green. |
| `VAULT_KEK_WRAPPED` | Base64 ciphertext from `vault kek-wrap` on a laptop. |
| `VAULT_KMS_KEY_ID` | Staging or prod CMK ARN. |
| `AWS_ROLE_ARN` | Fly OIDC role. No static AWS access keys. |
| `VAULT_KEK_REQUIRE_KMS` | Set `1` only after health is 200 with wrapped unwrap. |

Full procedure: [kek-rotation.md](kek-rotation.md).

## First-party auth

Set `VAULT_SESSION_SECRET` and `VAULT_OIDC_PRIVATE_JWK` before deploy. Confirm `/sign-up`, `/enroll-totp`, `/console`, well-known metadata, and unauthenticated `POST /mcp` 401 before promoting prod. Rollback: revert the Fly SHA. Do not run Clerk on this origin again.

## Resend

Verified sending domains are the public hosts: `botpasses.com` and `staging.botpasses.com`. From matches the plane: `Botpasses <noreply@staging.botpasses.com>` on staging, `Botpasses <noreply@botpasses.com>` on production. Fly `RESEND_API_KEY` is a Resend `sending_access` key scoped to that domain. Do not put a full-access Resend key on Fly. All Resend DNS records stay grey-cloud.

## Verify

```bash
curl -fsS https://staging.botpasses.com/health
# {"ok":true,"product":"botpasses"}
curl -fsS https://botpasses.com/health
```

MCP connector URL: `https://botpasses.com/mcp` (prod) or `https://staging.botpasses.com/mcp`.

## Remaining operator checklist

DNS and staging health were completed 2026-08-31. Production is DNS-only until a promote. Do not give users a platform default hostname.

| Step | Status |
| --- | --- |
| Fly apps `botpasses-staging` / `botpasses-prod` | **done**. Staging is deployed. Prod has IPs and an Origin CA cert, no Machines (not promoted). |
| Staging secrets `VAULT_PUBLIC_URL=https://staging.botpasses.com` and `VAULT_DEPLOY_PLANE=staging` | **done** 2026-08-31. A leftover `VAULT_PUBLIC_URL` secret without `VAULT_DEPLOY_PLANE` caused hosted boot exit 78 until both were set. |
| GitHub `FLY_API_TOKEN` deploys `botpasses-staging` | **done** (push to `dev` is green). |
| Cloudflare orange-cloud A/AAAA to Fly IPs, `_fly-ownership` TXT, ACME CNAMEs, `www` 301, cache bypass, Always HTTPS, Full (strict) | **done** 2026-08-31. Let's Encrypt HTTP-01 cannot complete through Fly `force_https`; Origin CA was imported on both apps so Full (strict) works. |
| First green staging `/health` through Cloudflare | **done**. `curl -fsS https://staging.botpasses.com/health` → `{"ok":true,"product":"botpasses"}`. |
| `https://botpasses.com/health` | **not yet**. Apex DNS points at `botpasses-prod` IPs. No prod Machine until promote. Expect Cloudflare 521/timeout. |
| First-party auth secrets + delete `clerk.*` CNAMEs | **done** 2026-09-01. `VAULT_SESSION_SECRET` and `VAULT_OIDC_PRIVATE_JWK` set on staging. Clerk secrets were already absent. Delete leftover `clerk.*` CNAMEs in Cloudflare when you next edit DNS. |
| Resend domains `botpasses.com` and `staging.botpasses.com` verified; sending keys on Fly | **done** 2026-09-01. Staging `RESEND_API_KEY` + `VAULT_EMAIL_FROM` deployed. Prod email secrets staged (no Machines until promote). |
| `gh repo rename botpasses` then update git remote | **done** 2026-08-30. Repo is `naffis/botpasses`. Do not create a new `naffis/agent-vault`. |
