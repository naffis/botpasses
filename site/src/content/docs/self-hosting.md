---
title: Self-hosting
description: Run the hosted process on any Postgres 16 and an https origin you control. Laptop hosted:dev uses sqlite. Fly, Neon, Cloudflare, and AWS KMS are the reference stack. Required secrets table.
section: help
order: 3
---

The hosted process is one Node.js service. The runtime contract is a Postgres 16 URL, an `https` origin you control, and a platform key (raw on a laptop; KMS-wrapped in production). The reference deployment is one Fly Machine per plane, Neon Postgres, Cloudflare DNS and WAF in front, and AWS KMS holding the key that wraps the platform key. Any other Postgres 16 and any non-platform-default `https` origin work the same. The code is MIT licensed at [github.com/naffis/botpasses](https://github.com/naffis/botpasses).

For a laptop hosted kernel (loopback, sqlite-hosted, OTP printed in the terminal) run `npm run hosted:dev`. That sets `VAULT_DEPLOY_PLANE=dev` and does not inherit a leftover `DATABASE_URL`. Run one process per sqlite file; a second writer can get SQLITE_BUSY. Do not set plane `dev` on Fly.

This page names what you need. The operational runbooks live in the repository under `docs/ops` ([cutover](https://github.com/naffis/botpasses/blob/dev/docs/ops/botpasses-cutover.md), [KEK rotation](https://github.com/naffis/botpasses/blob/dev/docs/ops/kek-rotation.md), [restore](https://github.com/naffis/botpasses/blob/dev/docs/ops/restore.md)).

Paste the [self-host prompt](/docs/prompts#self-host) into an ops agent so it follows this page and `docs/ops` instead of inventing steps. Do not paste secret values into chat.

## Copy-paste prompt

```
Help me deploy a self-hosted Botpasses plane from https://github.com/naffis/botpasses. Goal: a private grant-vault my agents hit at our origin (not necessarily botpasses.com). Follow docs/self-hosting and docs/ops in the repo. Do not invent secret values; ask me to set them in the secret store.

Reference shape (adapt to our cloud if we are not on Fly):
- One Node process: VAULT_MODE=hosted vault serve (one Machine per plane; in-memory enroll/rate-limit state).
- Postgres 16 (any vendor): separate database per plane; pooled DATABASE_URL + direct DATABASE_URL_DIRECT.
- Edge DNS/WAF (Cloudflare or ours) with SSL full strict.
- AWS KMS (or approved KMS) wrapping VAULT_KEK_WRAPPED; VAULT_KMS_APP_ID or FLY_APP_NAME; Fly OIDC or equivalent for AWS_ROLE_ARN.
- Email provider for codes (Resend pattern: RESEND_API_KEY + VAULT_EMAIL_FROM).
- Optional: R2/S3 encrypted backups, Sentry without values.
- Laptop hosted kernel is npm run hosted:dev (VAULT_DEPLOY_PLANE=dev, loopback, sqlite). That plane is refused when FLY_APP_NAME is set.

Required config checklist (confirm each is set in secrets, never paste into chat):
DATABASE_URL (Postgres URL), DATABASE_URL_DIRECT, VAULT_PUBLIC_URL (our https origin), VAULT_DEPLOY_PLANE (staging|production), VAULT_KEK_WRAPPED, VAULT_KMS_KEY_ID, VAULT_KMS_APP_ID or FLY_APP_NAME, AWS_ROLE_ARN, VAULT_KEK_REQUIRE_KMS=1 after cutover, VAULT_SESSION_SECRET (>=32 bytes), VAULT_OIDC_PRIVATE_JWK, VAULT_APPROVAL_HMAC (64 hex), bootstrap token pair only for break-glass window, VAULT_TRUST_PROXY as appropriate.

Build:
npm ci
npm --prefix site ci && npm --prefix site run build
VAULT_MODE=hosted VAULT_BIND_HOST=0.0.0.0 PORT=8788 npx vault serve
Exit 78 means config is wrong; fix from the self-hosting table.

After /health and /ready pass:
1. Create the first operator account on our VAULT_PUBLIC_URL (email code + TOTP).
2. Issue a model/agent token or complete OAuth for our MCP clients against https://<our-origin>/mcp.
3. Give developers the hosted agent bootstrap prompt, with every botpasses.com URL replaced by our origin (including /connect/callback on provider apps).
4. Write a short internal runbook: who holds KMS, how to revoke an agent, how to rotate KEK (vault kek-rotate), backup restore pointer under docs/ops.

Constraints: do not scale to two Machines without moving in-memory state to the database. Do not branch production Postgres from staging. Never log or return credential values.
```

## Components

| Component | Role |
| --- | --- |
| Fly.io app | Runs `VAULT_MODE=hosted vault serve`. One Machine. Health checks on `/health` and `/ready` |
| Neon Postgres | All hosted data. Use a separate project per plane; do not branch production from staging. Pooled URL for the app, direct URL for backups |
| Cloudflare | Orange-cloud DNS for the apex and `staging.` host, WAF, SSL Full (strict). `www` is a 301 to the apex |
| AWS KMS | A customer managed key the Fly Machine can call through Fly OIDC. It unwraps the platform key at boot |
| Resend | Email codes and approval notices from a verified sending domain |
| Cloudflare R2 | Encrypted nightly `pg_dump` from a GitHub Actions job |
| Sentry (optional) | Error reports. Values are never included |

## Build and run

```bash
npm ci
npm --prefix site ci && npm --prefix site run build   # the marketing site must exist at boot
VAULT_MODE=hosted VAULT_BIND_HOST=0.0.0.0 PORT=8788 npx vault serve
```

Hosted mode reads its listen address from `VAULT_BIND_HOST` and `PORT` (or `VAULT_PORT`); the `--host` and `--port` flags belong to the local `vault serve` only. The process exits with code 78 when configuration is wrong: `npm run hosted` without `VAULT_MODE=hosted`, a short session secret, a missing RS256 private JWK, a `VAULT_OIDC_PREVIOUS_JWK` that is not a private RS256 JWK, `RESEND_API_KEY` without `VAULT_EMAIL_FROM`, `VAULT_HOME` set in hosted mode, or a missing `site/dist/index.html`. The Dockerfile in the repository builds the site and installs the CLI in one image.

## Required secrets

| Secret | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres 16 URL (any vendor). The reference stack uses a Neon pooled (`-pooler`) host |
| `DATABASE_URL_DIRECT` | Direct Postgres URL for backups and migrations |
| `VAULT_PUBLIC_URL` | The origin this plane serves. First-party hosts must match the plane. A custom `https` origin is allowed on self-hosted staging/production. Loopback is plane `dev` only |
| `VAULT_DEPLOY_PLANE` | `staging`, `production`, or `dev`, required. Staging refuses vault environment `production`. Unset is exit 78. `dev` is the laptop hosted kernel and is refused when `FLY_APP_NAME` is set |
| `VAULT_KEK_WRAPPED` | The platform key, wrapped by KMS. Produced by `vault kek-wrap` |
| `VAULT_KMS_KEY_ID` | The KMS key id or ARN |
| `VAULT_KMS_APP_ID` | Optional. KMS EncryptionContext `app` when `FLY_APP_NAME` is unset |
| `AWS_ROLE_ARN` | Role the Machine assumes through Fly OIDC; it needs `kms:Decrypt` on that key |
| `VAULT_KEK_REQUIRE_KMS` | Set to `1` after the wrapped key is confirmed. Refuses to boot on the raw key |
| `VAULT_KEK` | Raw platform key. Pre-cutover fallback only; unset it after `VAULT_KEK_REQUIRE_KMS=1` |
| `VAULT_SESSION_SECRET` | 32 bytes or more. Signs sessions and CSRF tokens |
| `VAULT_OIDC_PRIVATE_JWK` | RS256 private JWK that signs OAuth access tokens |
| `VAULT_OIDC_PREVIOUS_JWK` | Only during a key rotation: the JWK being retired. Published in JWKS and still verifies the tokens it signed; never signs new ones |
| `VAULT_APPROVAL_HMAC` | Signs email approval links. 64 hex characters (32 bytes); any other shape is exit 78 |
| `VAULT_BOOTSTRAP_TOKEN` | 32 characters or more. Break-glass operator token; keep it offline. Every use is logged as `auth_bootstrap_used` with a token hash |
| `VAULT_BOOTSTRAP_ALLOW_PLANE` | Set to `1` only for the break-glass window. Staging and production ignore `VAULT_BOOTSTRAP_TOKEN` unless this is `1`; unset both afterwards |
| `VAULT_TRUST_PROXY` | Set to `1` when a proxy you control (nginx, Caddy) sits in front and appends `X-Forwarded-For`; only that last hop is then trusted. `Fly-Client-IP` is trusted only on Fly (`FLY_APP_NAME`), which also implies this setting. Otherwise the socket peer is the caller's address for rate limits and logs |
| `RESEND_API_KEY` | Sending-access key scoped to your domain |
| `VAULT_EMAIL_FROM` | For example `Botpasses <noreply@example.com>`. Required when `RESEND_API_KEY` is set |
| `SENTRY_DSN` | Optional; a plane without it logs `sentry_dsn_missing` at boot |
| `VAULT_TRUSTED_PROXY_CIDRS` | Optional. Comma-separated CIDRs of the CDN in front of the plane. `CF-Connecting-IP` is read for rate limits only when the connecting address is inside them. Unset means Cloudflare's published ranges; empty means the header is never read |
| `VAULT_BIND_HOST` | Optional. Listen address. Default `127.0.0.1` on plane `dev`, `0.0.0.0` on staging/production |
| `PORT` | Optional. Listen port, default `8788`; Fly sets it. `VAULT_PORT` is read when `PORT` is unset |
| `VAULT_SITE_ROOT` | Optional. Directory of the built Astro site, default `./site/dist`; boot exits 78 when its `index.html` is missing |

Backup job secrets (GitHub Actions, not Fly): `DATABASE_URL_DIRECT`, `BACKUP_KEY` (32-byte hex, must not be the vault key), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. The job fails closed when R2 is unset.

## Key hierarchy

1. The AWS KMS key (non-exportable) unwraps `VAULT_KEK_WRAPPED` once at boot.
2. The platform key in process memory wraps one data key per organisation.
3. The organisation key encrypts each credential with AES-256-GCM, bound to the organisation id.

A database dump alone cannot decrypt anything. Rotation: `vault kek-rotate` re-wraps the organisation keys under a new platform key.

## DNS

Orange-cloud `A` and `AAAA` records for the apex and the staging host, plus a grey-cloud `_fly-ownership` TXT record for Fly's certificate. `www` redirects to the apex at Cloudflare.

## Limits of the reference deployment

Some state (pending authenticator enrollments, per-IP limiters) lives in process memory, so the design is one Machine per plane. Do not scale to two Machines without moving that state to the database.
