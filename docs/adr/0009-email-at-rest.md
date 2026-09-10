# 0009. Email at rest, OAuth tokens at rest

- Status: accepted
- Date: 2026-09-09

## Context

A Neon dump already cannot decrypt item values if the plane KEK lives in KMS. The same dump
still yielded every operator inbox (`users.email`, OTP rows, invites) and live OAuth adapter
tokens: `oidc_payloads.id` is the refresh token, auth code, device code, or session cookie
that oidc-provider looks up. Payload JSON was plaintext. A dump was session theft, not only
a PII leak. Magic-link tokens were stored in `approval_challenges.code_hash`.

Encrypting only `oidc_payloads.payload` and leaving `id` as the token is a no-op. HMAC of
`Grant.id` would break `deleteOidcPayloadsByGrantId`, which joins plaintext `grant_id` to
`Grant.id`.

## Decision

- Operator inboxes (users, invites, OTP lookup) are stored as
  `HMAC-SHA256(HKDF(identityDEK, "botpasses/email-lookup/v1"), "email:" || normalized)`
  (64 lowercase hex). The inbox itself is AES-256-GCM under the identity DEK
  (AAD `email:${userId}` / `invite_email:${inviteId}`). `@` in the column means legacy
  plaintext; boot rebind wraps those rows after listen and does not gate `/ready`.
- Bearer OIDC kinds (RefreshToken, AuthorizationCode, DeviceCode, AccessToken, Session,
  Interaction) HMAC the presented id the same way (`botpasses/oidc-lookup/v1`). Ciphertext
  plaintext is `JSON.stringify({ id, body })` so restore can invert HMAC. AAD is
  `oidc:${kind}:${storedId}`. `user_code` and `uid` columns are HMAC; `grant_id`,
  `client_id`, and `account_id` stay plaintext.
- **Grant.id is never HMAC'd.** Revoke decrypts Grant payloads, then deletes by the
  plaintext Grant id. That leftover Grant id is an internal oidc-provider id, not a
  client-held bearer.
- Magic links store `sha256Hex(token)` in `approval_challenges.code_hash`. Reuse of a live
  challenge returns `{ fresh: false }` without the token. 8-digit codes already hash.
- The store stays crypto-agnostic. `createOauthProvider` requires `oidcDirectory`. There is
  no plaintext adapter fallback.
- Item names, last-4, usernames, allowed hosts, and need/grant task text stay plaintext.
  That metadata is accepted residual, named below.

## Residual inventory (accepted; not this change)

- Item metadata in the dump (names, last-4, username, hosts, inject). Needed for
  `list_items` and the console without decrypting every row.
- Need/grant `task_description` and suggested names. Targeting intel, not decrypt.
- Plaintext Grant ids (internal; not client-held bearers).
- `avt_` `POST /runtime/resolve`. Inject by design.
- Fly process memory. The KEK must be in RAM for `http_request`.
- Shared platform KEK. One KMS role unwraps every org. BYOK is out of scope (ADR 0007).
- 8-digit OTP + scrypt (N=16384). Online: 5 attempts. Offline dump of a live 10-minute row
  is a slow guess; TOTP is still required.
- `GET /collect/:id` 200 vs 404. Shell only; fulfill needs an operator session.
- Collect page bootstrap form. Honoured only with `VAULT_BOOTSTRAP_ALLOW_PLANE=1`.
- Collect host prefill and connect auto-`item_standing`. Product choices; not dump-crypto.
- Username outside item AAD. Bind-integrity; not this change.
- In-process IP OTP limiter. Lost on restart.
- `logAuthEvent` 12-hex SHA-256 of email. Unkeyed; not joined to HMAC columns.
- `BACKUP_KEY` + R2. Decrypts to the same dump (metadata yes; values, inboxes, and bearer
  tokens no after this change).
- `clerk_oauth_user_id` leftover column. Alias only.

## Consequences

- Sign-in, invites, approval mail, MCP OAuth, and client revoke still work.
- Authenticated operator JSON still shows inboxes. SQL does not gain a new plaintext email
  column.
- KEK rotate keeps the identity DEK bytes; hashes stay valid.
- Rollback: run `scripts/email-restore-plaintext.ts` and `scripts/oidc-restore-plaintext.ts`,
  then revert the image. Never revert first.

## Alternatives considered

- Email-derived DEKs, unlinkable identity, a second identity database, sidecar
  zero-knowledge, per-org CMK / BYOK, CipherStash EQL.
- Encrypting item names, last-4, hosts, or usernames.
- HMAC of Grant.id.
- Optional crypto directory / plaintext oidc fallback.
- A new Fly pepper for the HMAC (KEK rotate would rehash).
