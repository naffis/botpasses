# Restore a hosted dump

Hosted rows live in Neon. Instant restore on the root branch covers the history window (7 days on staging). This runbook is the offsite copy: a `pg_dump` custom file encrypted with `BACKUP_KEY`, not the vault KEK.

Nightly `backup-prod.yml` only runs from GitHub’s default branch. Trunk is `dev`. Set the default branch to `dev` after the Actions secrets below exist. A job without R2 secrets is a failure (`require-offsite-env`). Do not enable the cron while those secrets are missing (it will fail every night).

GitHub Actions secret names: `DATABASE_URL_DIRECT`, `BACKUP_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. These are not Fly secrets.

## Decrypt a dump

```bash
export BACKUP_KEY=   # 32-byte hex; not VAULT_KEK
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  scripts/hosted-backup.ts decrypt botpasses-<stamp>.dump.enc vault.dump
```

Wrong key fails closed (GCM auth).

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
