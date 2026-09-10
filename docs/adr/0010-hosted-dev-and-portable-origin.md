# 0010. Hosted-dev plane and portable self-host origin

- Status: accepted
- Date: 2026-09-10
- Amends: [0002](0002-botpasses-com-origin.md)

## Context

ADR 0002 pinned every hosted `VAULT_PUBLIC_URL` to a first-party botpasses.com origin. Self-host docs already promised "your origin" and any Postgres URL. The laptop CLI already used SQLite. The multi-user hosted process refused both: no SQLite, no loopback, no custom https host.

Operators need two extra jobs that 0002 did not cover:

1. Run the hosted kernel on a laptop (`npm run hosted:dev`) without Neon, Fly, or a marketing site build.
2. Self-host on any Postgres 16 and any non-platform-default `https` origin.

Sqlite-hosted on a Fly Machine would lose the vault on every deploy. A leftover shell `DATABASE_URL` would open the operator's staging database with a laptop raw KEK.

## Decision

- `VAULT_DEPLOY_PLANE` accepts `dev` in addition to `staging` and `production`. `dev` is a process plane, not a `VaultEnvName`. Default item and OAuth environment on `dev` is `staging`; both vault environments remain listable.
- Plane `dev` with no `DATABASE_URL` opens sqlite-hosted at `VAULT_HOSTED_SQLITE` or `.botpasses-hosted/hosted.sqlite`. With a URL it opens the generic `pg` store. Staging and production still require Postgres and still refuse `VAULT_HOME`.
- `FLY_APP_NAME` plus plane `dev` is exit 78. Self-host on Fly uses `staging` or `production` plus Postgres.
- First-party hosts still match the plane. Custom `https` origins are allowed on staging and production. Loopback is allowed on `dev` (and in tests that set `allowLoopback`). Platform-default hostnames stay refused.
- `npm run hosted:dev` writes `.botpasses-hosted/secrets.json` once (mode `0o600`), binds `127.0.0.1`, aligns `VAULT_PUBLIC_URL` with `PORT`, and does not copy a parent `DATABASE_URL`, `VAULT_HOME`, or `FLY_APP_NAME`. `--postgres` or `VAULT_HOSTED_DEV_DATABASE_URL` is the opt-in Postgres path. `--check` evaluates boot without listening.
- Hosted `chooseRedirect` is always `{origin}/connect/callback` and never accepts port 8888. Port 8888 stays the CLI vault callback.
- Plane `dev` defaults `VAULT_BIND_HOST` to `127.0.0.1`. Staging and production stay `0.0.0.0`. An explicit bind wins.
- Dev OTP is written to stderr by `createDevMailer`. Structured events must not contain the code.
- Loopback HTTP cookies are `bp_session` without `Secure`. `__Host-` remains HTTPS-only.
- KMS EncryptionContext `app` is `VAULT_KMS_APP_ID` or `FLY_APP_NAME`.

ADR 0002 still holds for first-party botpasses.com planes. This ADR unlocks portable self-host and a laptop hosted-dev plane. It does not introduce MySQL, D1, LiteFS, or production SQLite.

## Consequences

- Self-host docs name capabilities (Postgres URL, https origin, KMS app id), not a single vendor.
- A laptop `.botpasses-hosted/` dump plus `secrets.json` decrypts items. That plane is not dump-resistant.
- `usedRawKekFallback` fires only on staging and production.
- `dev` robots and page headers follow staging (no first-party sitemap on a laptop).

## Alternatives considered

- Merge CLI `VAULT_HOME` with sqlite-hosted. Rejected: different schemas; hosted mode already refuses `VAULT_HOME`.
- Production SQLite / LiteFS. Rejected: no PITR; grant-vault plan already refused it.
- Compose-only laptop path. Rejected: leftover `DATABASE_URL` is the common footgun; the script is an allowlist.
