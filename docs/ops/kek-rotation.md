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

Do this only after both planes run an image that has `rotateKek`.

```bash
export DATABASE_URL=...   # Neon direct
export VAULT_KEK=<current raw, or unwrap via KMS first>
export VAULT_KMS_KEY_ID=...
export VAULT_DEPLOY_PLANE=production
export FLY_APP_NAME=botpasses-prod
npx vault kek-rotate
```

The command tries unwrap-with-new then unwrap-with-old per org. Re-run the same old+new pair after a crash. Then `fly secrets set VAULT_KEK_WRAPPED=<new blob>` and restart. Keep the old CMK version until every org unwraps with the new KEK.
