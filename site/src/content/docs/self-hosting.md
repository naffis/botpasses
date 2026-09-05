---
title: Self-hosting
description: Run the hosted Botpasses process yourself on Fly with Neon Postgres, Cloudflare in front, and an AWS KMS key wrapping the platform key. Required secrets table.
section: help
order: 3
---

The hosted process is one Node.js service. The reference deployment is one Fly Machine per plane, Neon Postgres, Cloudflare DNS and WAF in front, and AWS KMS holding the key that wraps the platform key. The code is MIT licensed at [github.com/naffis/botpasses](https://github.com/naffis/botpasses).

This page names what you need. The operational runbooks live in the repository under `docs/ops` ([cutover](https://github.com/naffis/botpasses/blob/dev/docs/ops/botpasses-cutover.md), [KEK rotation](https://github.com/naffis/botpasses/blob/dev/docs/ops/kek-rotation.md), [restore](https://github.com/naffis/botpasses/blob/dev/docs/ops/restore.md)).

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
| `DATABASE_URL` | Neon pooled connection string (`-pooler` host) |
| `DATABASE_URL_DIRECT` | Neon direct connection string, for backups and migrations |
| `VAULT_PUBLIC_URL` | The origin this plane serves, for example `https://botpasses.com`. Must match the deploy plane |
| `VAULT_DEPLOY_PLANE` | `staging` or `production`, required. Staging refuses vault environment `production`. Unset is exit 78 |
| `VAULT_KEK_WRAPPED` | The platform key, wrapped by KMS. Produced by `vault kek-wrap` |
| `VAULT_KMS_KEY_ID` | The KMS key id or ARN |
| `AWS_ROLE_ARN` | Role the Machine assumes through Fly OIDC; it needs `kms:Decrypt` on that key |
| `VAULT_KEK_REQUIRE_KMS` | Set to `1` after the wrapped key is confirmed. Refuses to boot on the raw key |
| `VAULT_KEK` | Raw platform key. Pre-cutover fallback only; unset it after `VAULT_KEK_REQUIRE_KMS=1` |
| `VAULT_SESSION_SECRET` | 32 bytes or more. Signs sessions and CSRF tokens |
| `VAULT_OIDC_PRIVATE_JWK` | RS256 private JWK that signs OAuth access tokens |
| `VAULT_OIDC_PREVIOUS_JWK` | Only during a key rotation: the JWK being retired. Published in JWKS and still verifies the tokens it signed; never signs new ones |
| `VAULT_APPROVAL_HMAC` | Signs email approval links. 64 hex characters (32 bytes); any other shape is exit 78 |
| `VAULT_BOOTSTRAP_TOKEN` | 32 characters or more. Break-glass operator token; keep it offline. Every use is logged as `auth_bootstrap_used` with a token hash |
| `VAULT_BOOTSTRAP_ALLOW_PLANE` | Set to `1` only for the break-glass window. Staging and production refuse to boot with `VAULT_BOOTSTRAP_TOKEN` set unless this is `1`; unset both afterwards |
| `VAULT_TRUST_PROXY` | Set to `1` when a proxy you control (nginx, Caddy) sits in front and appends `X-Forwarded-For`; only that last hop is then trusted. `Fly-Client-IP` is trusted only on Fly (`FLY_APP_NAME`), which also implies this setting. Otherwise the socket peer is the caller's address for rate limits and logs |
| `RESEND_API_KEY` | Sending-access key scoped to your domain |
| `VAULT_EMAIL_FROM` | For example `Botpasses <noreply@example.com>`. Required when `RESEND_API_KEY` is set |
| `SENTRY_DSN` | Optional; a plane without it logs `sentry_dsn_missing` at boot |
| `VAULT_TRUSTED_PROXY_CIDRS` | Optional. Comma-separated CIDRs of the CDN in front of the plane. `CF-Connecting-IP` is read for rate limits only when the connecting address is inside them. Unset means Cloudflare's published ranges; empty means the header is never read |
| `VAULT_BIND_HOST` | Optional. Listen address of the hosted process, default `0.0.0.0` |
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
