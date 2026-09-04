# Botpasses threat model

Living document. Trust decision: [ADR 0006](../adr/0006-grant-vault-trust-model.md). KEK wrap: [ADR 0007](../adr/0007-kms-wrapped-kek.md). Hardening after the 2026-09 audit: [ADR 0008](../adr/0008-security-hardening.md).

Botpasses is a **grant-vault**. The model never sees secret values. The hosted process decrypts at approved inject. This is not a human password manager and it is not client-side encryption that the vendor cannot undo.

## Actors

| Actor | What they hold | What they can decrypt |
| --- | --- | --- |
| Operator (browser / CLI) | First-party session (email OTP + TOTP), bootstrap token, or local `VAULT_MASTER_KEY` | Local: yes, with the master key. Hosted: they type values in; they cannot read stored values back. |
| Model client (`avm_`, or an OAuth access token bound to one org) | Hashed bearer, or an RS256 JWT carrying `org_id` whose `sub` must still be a member | Names, grants, `collect_url`, redacted connector body. Never `value`. |
| Trusted runtime (`avt_`) | Hashed bearer | `POST /runtime/resolve` returns `value` for an active grant. That is inject. |
| Hosted Fly process | Unwrapped platform KEK in memory (from KMS or, before cutover, raw `VAULT_KEK`) | Yes, at inject. Required for `http_request`. |
| AWS KMS role (Fly OIDC) | `kms:Decrypt` on the plane CMK | Unwraps the platform KEK only. Does not see item plaintext. |
| Reverse proxy (Fly edge, Cloudflare) | The client address headers | Nothing. Its headers are believed only when the process knows it is behind that proxy (see Proxy trust). |
| Neon dump alone | Ciphertext + wrapped DEKs | No, without the platform KEK. |
| R2 `pg_dump` blob | AES-256-GCM dump (`BACKUP_KEY`, `BPBK` versioned envelope) | No item plaintext. `BACKUP_KEY` must not be the vault KEK. A job that skips R2 is not a backup. |
| Botpasses staff without KMS + DB | Deploy logs, Sentry (redacted) | No. |
| Attacker with Fly secrets + Neon | Raw KEK if cutover is incomplete; otherwise wrapped blob + role | Before `VAULT_KEK_REQUIRE_KMS=1`: yes. After cutover: needs the KMS role as well. |

## Assets

- Item payloads (API keys, login passwords). Each envelope is bound with AAD `orgId|itemId|allowed_hosts_json|inject`, so a writer with database access cannot move a ciphertext to another item or change the hosts or inject mode a value may be sent with. Rows written before that binding (AAD `orgId` alone) are re-encrypted once at boot (`aad_rebind`); `items.aad_version` records it and the inject path accepts only the bound form.
- Per-org DEKs (wrapped under the platform KEK, AAD `orgId`).
- Platform KEK (32 bytes). After cutover: ciphertext in `VAULT_KEK_WRAPPED`.
- Machine tokens (`avm_`, `avt_`) stored as SHA-256 hashes.
- OAuth signing key (`VAULT_OIDC_PRIVATE_JWK`) and, during a rotation only, the retiring key (`VAULT_OIDC_PREVIOUS_JWK`, verify-only).
- Collect URLs (`/collect/:needId`, path-only, no HMAC).
- Approval links, signed with `VAULT_APPROVAL_HMAC` (64 hex characters, refused otherwise) and bound to the org.

## Key hierarchy (hosted, after cutover)

1. AWS CMK (non-exportable) unwraps `VAULT_KEK_WRAPPED` once at boot. During a rotation the previous KEK (`VAULT_KEK_PREVIOUS_WRAPPED`) is unwrapped as well; a DEK still under it is re-wrapped under the current KEK on first use (`dek_rewrapped` audit row).
2. Platform KEK in process memory wraps per-org DEKs (AAD `orgId`).
3. Org DEK encrypts item payloads (AAD `orgId|itemId|allowed_hosts_json|inject`).

Local: `VAULT_MASTER_KEY` / `master.key` encrypts sqlite rows. AAD is the secret name after this change. The key file must not be readable by group or others; the CLI refuses one that is.

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

## Trust decided at boot

A hosted process refuses to start (exit 78) rather than run with a weaker configuration than the operator believes it has:

- `VAULT_DEPLOY_PLANE` must be `staging` or `production`; there is no default plane.
- `VAULT_AUTH_MODE=test` is refused in every hosted boot. Header principals exist only in the test suite.
- `VAULT_APPROVAL_HMAC` must be 64 hex characters when set.
- `VAULT_BOOTSTRAP_TOKEN` is honoured on a plane only with `VAULT_BOOTSTRAP_ALLOW_PLANE=1`. A set token is logged at boot and every use writes an `auth_bootstrap_used` event with a token hash, address, method, and path. The intended end state is no bootstrap token on production.
- `RESEND_API_KEY` without `VAULT_EMAIL_FROM`, a short session secret, a missing JWK, or an unreadable site directory are all refusals.

The local plane splits its loopback bearers: `vault serve` prints an operator bearer for `/api` and a model bearer for `/mcp`; neither is accepted on the other surface.

## Proxy trust

Client addresses feed rate limits and audit rows. `Fly-Client-IP` and the last `X-Forwarded-For` hop are believed only behind Fly (`FLY_APP_NAME`) or with `VAULT_TRUST_PROXY=1`; otherwise the socket peer is the address. `CF-Connecting-IP` is believed only when the address Fly saw is inside `VAULT_TRUSTED_PROXY_CIDRS` (unset means Cloudflare's published ranges, empty means never). On HTTPS the session and CSRF cookies are read only under their `__Host-` names and only on a request the proxy marks `x-forwarded-proto: https`; there is no plain-name fallback.

## Single-use state

Every counter and one-time value the sign-in path depends on is claimed with one conditional `UPDATE ... RETURNING` in the store, on SQLite and Postgres alike: email-code attempts, authenticator failures, the authenticator step-replay guard, backup-code redemption, and OIDC payload consumption. Two concurrent requests cannot share a slot or redeem the same code twice. The CSRF token is signed for the session it travels with, so a token from another session is refused.

## Request path and grant semantics

- One canonical path. `canonicalRequestPath()` rejects backslashes, percent-encoded separators (`%2F`, `%5C`, `%2E`), dot segments (including `..;`), whitespace, and fragments. Its output is the only path used for the SSRF check, the scope comparison, the inbox card, the audit row, and the wire, so the operator approves exactly what is sent.
- A prompt grant is spent by any origin response. It comes back to the agent only when the send never left the process (DNS, connect, TLS, or a timeout before any bytes). Retryable work uses `max_calls` or a session grant.
- The connector dials port 443 only, sends `accept-encoding: identity`, caps a response at 1 MiB of raw bytes (502 `body_too_large`), and fails a call whose origin closes early instead of hanging it. Response headers and bodies are redacted against the secret in every encoding the request could have carried it (raw, percent, form, HTML entity, base64 of `user:secret`).
- OAuth consent binds an org (`org:<id>` on the grant). A revoked client stays revoked until a fresh authorization-code or device-code issuance; a refresh for a revoked client fails, and revocation destroys the OIDC payloads of every member of the org for that client.
- A removed owner never re-enters the org they created: personal orgs get random ids, `orgs.created_by` is recorded, and a fresh org is provisioned instead.

## Expand/contract

The first image of the KMS change still boots on raw `VAULT_KEK` when `VAULT_KEK_REQUIRE_KMS` is unset (`kek_raw_fallback`). Cutover sets wrapped secrets, confirms health, then sets `VAULT_KEK_REQUIRE_KMS=1` and unsets `VAULT_KEK`. Key rotation runbooks: [KEK](../ops/kek-rotation.md), [OAuth signing key](../ops/oidc-key-rotation.md).
