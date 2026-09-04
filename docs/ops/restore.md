# Restore a hosted dump

Hosted rows live in Neon. Instant restore on the root branch covers the history window (7 days on staging). This runbook is the offsite copy: a `pg_dump` custom file encrypted with `BACKUP_KEY`, not the vault KEK.

Nightly `backup-prod.yml` only runs from GitHub's default branch. Trunk is `dev`. Until the default branch is `dev` no backup runs; the steps are in [default-branch.md](default-branch.md) and `ci.yml` fails on `dev` pushes until it is done. A job without R2 secrets is a failure (`require-offsite-env`). Every run ends with a `backup-verify` job that downloads the object just written and decrypts it with `BACKUP_KEY`; a wrong key, a truncated upload, or a bad envelope header fails the run. Alerting: [alerts.md](alerts.md).

`pg_dump` comes from the PGDG `postgresql-client-16` package to match the Neon project's major (`PG_MAJOR` in the workflow). Bump it with the Neon upgrade.

GitHub Actions secret names: `DATABASE_URL_DIRECT`, `BACKUP_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. These are not Fly secrets.

## Decrypt a dump

```bash
export BACKUP_KEY=   # 32-byte hex; not VAULT_KEK
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  scripts/hosted-backup.ts decrypt botpasses-<stamp>.dump.enc vault.dump
```

Wrong key fails closed (GCM auth). The envelope is `BPBK`, one version byte (currently 1), then the AES-256-GCM nonce, tag, and ciphertext; the header is authenticated with the body. `decrypt` refuses a file without the magic (`bad magic`), a version it does not know (`unsupported backup envelope version`), or any edited byte, so a truncated download or an object from another tool never yields a partial dump.

## Restore into a scratch database

Never restore onto the live primary. Create a new Neon branch or a local Postgres 16, then:

```bash
pg_restore --no-owner --dbname="$SCRATCH_DATABASE_URL" vault.dump
```

Confirm item ciphertext still unwraps with the plane KEK (or KMS-wrapped KEK). A dump alone is not enough to read values.

## Neon instant restore

Console: project → Instant restore on the **protected** root branch. History window is `history_retention_seconds` (604800 = 7 days on Launch). Do not branch production from staging.

## Isolated production project

Provision `botpasses-prod` as a **new** Neon project. Set Fly `DATABASE_URL` / `DATABASE_URL_DIRECT` on `botpasses-prod` only. Do not copy staging ciphertext by branching.
