# Botpasses threat model

Living document. Trust decision: [ADR 0003](../adr/0003-grant-vault-trust-model.md). KEK wrap: [ADR 0004](../adr/0004-kms-wrapped-kek.md).

Botpasses is a **grant-vault**. The model never sees secret values. The hosted process decrypts at approved inject. This is not a human password manager and it is not client-side encryption that the vendor cannot undo.

## Actors

| Actor | What they hold | What they can decrypt |
| --- | --- | --- |
| Operator (browser / CLI) | First-party session (email OTP + TOTP), bootstrap token, or local `VAULT_MASTER_KEY` | Local: yes, with the master key. Hosted: they type values in; they cannot read stored values back. |
| Model client (`avm_`) | Hashed bearer | Names, grants, `collect_url`, redacted connector body. Never `value`. |
| Trusted runtime (`avt_`) | Hashed bearer | `POST /runtime/resolve` returns `value` for an active grant. That is inject. |
| Hosted Fly process | Unwrapped platform KEK in memory (from KMS or, before cutover, raw `VAULT_KEK`) | Yes, at inject. Required for `http.request`. |
| AWS KMS role (Fly OIDC) | `kms:Decrypt` on the plane CMK | Unwraps the platform KEK only. Does not see item plaintext. |
| Neon dump alone | Ciphertext + wrapped DEKs | No, without the platform KEK. |
| R2 `pg_dump` blob | AES-256-GCM dump (`BACKUP_KEY`) | No item plaintext. `BACKUP_KEY` must not be the vault KEK. A job that skips R2 is not a backup. |
| Botpasses staff without KMS + DB | Deploy logs, Sentry (redacted) | No. |
| Attacker with Fly secrets + Neon | Raw KEK if cutover is incomplete; otherwise wrapped blob + role | Before `VAULT_KEK_REQUIRE_KMS=1`: yes. After cutover: needs the KMS role as well. |

## Assets

- Item payloads (API keys, login passwords).
- Per-org DEKs (wrapped under the platform KEK, AAD `orgId`).
- Platform KEK (32 bytes). After cutover: ciphertext in `VAULT_KEK_WRAPPED`.
- Machine tokens (`avm_`, `avt_`) stored as SHA-256 hashes.
- Collect URLs (`/collect/:needId`, path-only, no HMAC).

## Key hierarchy (hosted, after cutover)

1. AWS CMK (non-exportable) unwraps `VAULT_KEK_WRAPPED` once at boot.
2. Platform KEK in process memory wraps per-org DEKs.
3. Org DEK encrypts item payloads (AAD `orgId`).

Local: `VAULT_MASTER_KEY` / `master.key` encrypts sqlite rows. AAD is the secret name after this change.

## Surfaces

| Surface | Sees secret value? |
| --- | --- |
| MCP tools | **No** |
| Operator console / HTTP JSON (except trusted resolve) | **No** after submit |
| CLI `list` / `grant` / `audit` | **No** |
| Audit table / email / inbox | **No** |
| Unauthenticated `GET /collect/:id` | **No** (shell only) |
| `vault run` child env / `POST /runtime/resolve` / connector origin | **Yes**. That is the inject |
| Model context / chat transcript | **Must not.** Tests fail if a canary appears |

## Expand/contract

The first image of the KMS change still boots on raw `VAULT_KEK` when `VAULT_KEK_REQUIRE_KMS` is unset (`kek_raw_fallback`). Cutover sets wrapped secrets, confirms health, then sets `VAULT_KEK_REQUIRE_KMS=1` and unsets `VAULT_KEK`.
