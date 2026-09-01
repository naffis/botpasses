# 0004. AWS KMS wraps the platform KEK

- Status: accepted
- Date: 2026-08-31

## Context

Hosted items are AES-256-GCM with a per-org DEK. The platform `VAULT_KEK` that wraps those DEKs lives in a Fly env var. Anyone with that secret plus a Neon dump decrypts every org. WorkOS names this failure: a KEK in an environment variable defeats envelope encryption. Fly KMS (`/.fly/kms`) has no GA docs as of 2026-08-31.

Staging already sets `VAULT_DEPLOY_PLANE=staging` and raw `VAULT_KEK`. Refusing raw-only on the first image of this change would exit 78 and take staging down.

## Decision

We will wrap the platform KEK with AWS KMS using Fly Machine OIDC (`AWS_ROLE_ARN` → `AWS_WEB_IDENTITY_TOKEN_FILE`). No static AWS access keys on the Machine.

EncryptionContext is `{ purpose: "vault-kek", plane, app: FLY_APP_NAME }` and must match on Encrypt and Decrypt.

Boot is expand/contract:

- Prefer `VAULT_KEK_WRAPPED` + `VAULT_KMS_KEY_ID` when both are set.
- Raw-only on a plane is allowed until `VAULT_KEK_REQUIRE_KMS=1`.
- `hostedBootError` stays a sync env check. Async `Decrypt` runs in `startHosted`.

`vault kek-wrap` and `vault kek-rotate` run on an operator laptop (AWS SSO or console), not as hosted HTTP. Rotation re-wraps org DEKs only (try unwrap with the new KEK, else unwrap with the old).

Tests use raw `VAULT_KEK` when `VAULT_AUTH_MODE=test`. Customer BYOK / per-org CMKs are out of scope.

## Consequences

- New runtime dependency `@aws-sdk/client-kms`.
- After cutover, a Neon dump without KMS cannot decrypt.
- Rollback: unset `VAULT_KEK_REQUIRE_KMS`, restore raw `VAULT_KEK`.
- Boot on the wrapped path depends on KMS + OIDC.

## Alternatives considered

- Keep `VAULT_KEK` in Fly secrets. Leaves the dump+secret hole open.
- Fly KMS. Preview-only, NaCl secretbox, no GA docs.
- WorkOS Vault as the store. We already store and inject; we lacked KMS for the KEK.
- Refuse raw KEK on plane immediately. First deploy kills staging.
