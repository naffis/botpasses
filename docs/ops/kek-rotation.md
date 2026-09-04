# KEK wrap and rotation

Platform KEK wrap: [ADR 0007](../adr/0007-kms-wrapped-kek.md).

Laptop commands. Fly OIDC (`AWS_ROLE_ARN`) exists only on the Machine. `vault kek-wrap` and `vault kek-rotate` use AWS SSO or a short-lived console Encrypt. Do not put AWS access keys in git or Fly secrets.

EncryptionContext (must match on Encrypt and Decrypt):

```
purpose=vault-kek
plane=staging|production
app=botpasses-staging|botpasses-prod   # FLY_APP_NAME
```

IAM: trust `oidc.fly.io/<org-slug>`, audience `sts.amazonaws.com`, `sub` `org:botpasses-staging:*` / `org:botpasses-prod:*`. Allow `kms:Decrypt` only when `kms:EncryptionContext:purpose` is `vault-kek` and `kms:EncryptionContext:app` is that Fly app.

## First cutover (staging)

1. Create a CMK in AWS. Note the key id / ARN.
2. Create the IAM OIDC provider and role. Set `AWS_ROLE_ARN` on the Fly app (`fly.toml` `[env]` or `fly secrets set`).
3. On a laptop with AWS SSO:

```bash
export VAULT_KMS_KEY_ID=arn:aws:kms:...
export VAULT_DEPLOY_PLANE=staging
export FLY_APP_NAME=botpasses-staging
printf '%s' "$VAULT_KEK" | npx vault kek-wrap
```

4. `fly secrets set VAULT_KEK_WRAPPED=<base64> VAULT_KMS_KEY_ID=<arn> AWS_ROLE_ARN=<arn> -a botpasses-staging`
5. Restart. Confirm `GET https://staging.botpasses.com/health` is 200.
6. `fly secrets set VAULT_KEK_REQUIRE_KMS=1 -a botpasses-staging`
7. `fly secrets unset VAULT_KEK -a botpasses-staging`

Prod is the same with `botpasses-prod` after staging is green.

## Rollback

`fly secrets unset VAULT_KEK_REQUIRE_KMS` and `fly secrets set VAULT_KEK=<old raw>`. Item rows are unchanged.

## Rotate the platform KEK

The process accepts two KEKs at once: the current one (`VAULT_KEK_WRAPPED` or raw `VAULT_KEK`) and the one being retired (`VAULT_KEK_PREVIOUS_WRAPPED`, or raw `VAULT_KEK_PREVIOUS` where raw is still allowed). Every org DEK and the identity DEK is opened with the current KEK first; a row still under the previous KEK opens with it and is re-wrapped under the current KEK in place (audit `dek_rewrapped`, log `dek_rewrapped`). Traffic therefore finishes the rotation on its own, without a maintenance window, and a process that restarts mid-way carries on. Boot refuses a previous key that equals the current one, a raw previous key under `VAULT_KEK_REQUIRE_KMS=1`, a bad key length, and both forms set at once (exit 78).

Order matters: the new KEK goes in as current with the old one as previous. Never run a process that has only the new KEK against a database that still has rows under the old one.

1. Generate the new KEK and wrap it: `openssl rand -hex 32`, then `printf '%s' "$NEW" | npx vault kek-wrap` with the plane's `VAULT_KMS_KEY_ID`, `VAULT_DEPLOY_PLANE`, and `FLY_APP_NAME`. Wrap the old KEK the same way if you only have it raw.
2. Set previous, then current, in one deploy so no process boots with the new KEK alone:

```bash
fly secrets set VAULT_KEK_PREVIOUS_WRAPPED=<old blob> VAULT_KEK_WRAPPED=<new blob> -a botpasses-prod
```

3. Confirm `/health` is 200 and `kek_previous_loaded` appears in the boot log.
4. Re-wrap the rest offline so no org stays on the old KEK waiting for its next request:

```bash
export DATABASE_URL=...   # Neon direct
export VAULT_KEK=<old raw, or unwrap via KMS first>
export VAULT_KEK_NEW=<new raw>
npx vault kek-rotate
```

   `kek-rotate` tries unwrap-with-new then unwrap-with-old per org and skips rows the running process already moved. Re-run the same old+new pair after a crash. Without `VAULT_KEK_NEW` it generates a fresh key, which is only right when step 2 has not happened yet.
5. Check the database: every `orgs` row and the `identity_keys` row unwrap with the new KEK (`kek-rotate` reports `rewrapped=0 skipped=<orgs>`).
6. `fly secrets unset VAULT_KEK_PREVIOUS_WRAPPED -a botpasses-prod` and retire the old CMK key version.

Raw-KEK planes (before the KMS cutover) use `VAULT_KEK_PREVIOUS` and `VAULT_KEK` in place of the wrapped pair.
