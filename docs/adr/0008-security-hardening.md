# 0008. Security hardening after the 2026-09 audit

- Status: accepted
- Date: 2026-09-04

## Context

A full review of the hosted plane, the OAuth authorization server, the MCP connector, the
local plane, and the deploy path found a set of flaws that share three root causes:

1. **Trust decided in the wrong place.** The plane could be left unset and default to
   production, the test auth resolver could be enabled in a hosted process, one loopback
   bearer served both the operator API and the model MCP endpoint, and a static bootstrap
   token worked on production without an audit trail.
2. **Read-then-write where the database must decide.** OTP attempts, TOTP failure counts,
   TOTP step replay, backup-code redemption, and OIDC payload consumption were all counted or
   consumed in application code between two queries, so concurrent requests could exceed the
   limit or reuse a one-time value.
3. **Two views of the same request.** The path the operator approved, the path the scope check
   compared, and the path sent to the origin could differ after percent-decoding and
   normalisation. The prompt grant reactivated after an origin had already spent it. The
   revoked-client flag was rebuilt by any refresh, including one from a different consenter.

Some safety properties also depended on procedures that could not be carried out while the
service was running: rotating the platform KEK required a stop-the-world rewrap, the
signing key for access tokens could not be rotated without invalidating every token, and
legacy items still verified against the old AAD (org id only) through a permanent fallback.

## Decision

- **Fail closed at boot.** `VAULT_DEPLOY_PLANE` must be `staging` or `production`.
  `VAULT_AUTH_MODE=test` is refused in every hosted boot. `VAULT_APPROVAL_HMAC` must be
  64 hex characters when set. `VAULT_BOOTSTRAP_TOKEN` is honoured on a plane only with
  `VAULT_BOOTSTRAP_ALLOW_PLANE=1`, is logged at boot, and every use writes a
  `bootstrap_used` auth event.
- **Two loopback bearers on the local plane.** `vault serve` derives an operator bearer for
  `/api` and a model bearer for `/mcp` from the master key with distinct labels. Neither is
  accepted on the other surface.
- **Atomic single-use state.** Every counter and one-time value is claimed with a single
  conditional `UPDATE ... RETURNING` in both stores. A miss is a refusal, never a retry.
- **One canonical request path.** `canonicalRequestPath()` rejects backslashes, encoded
  separators, and dot segments, and its output is the only path used for validation, scope
  comparison, the inbox card, the audit row, and the wire.
- **A prompt grant is spent by any origin response.** Reactivation happens only when the send
  never left the process (DNS, connect, TLS, or a timeout before any bytes). Retryable work
  uses `max_calls` or a session grant.
- **Consent binds an org.** The OAuth grant carries `org:<id>`; the access token check verifies
  current membership and creates nothing as a side effect. A revoked client stays revoked
  until a fresh authorization-code or device-code issuance; a refresh for a revoked client
  fails with `invalid_grant`, and revocation destroys the OIDC payloads of every member of the
  org for that client.
- **Rotation without downtime.** The runtime accepts a previous KEK (`VAULT_KEK_PREVIOUS`,
  raw or KMS-wrapped) and rewraps DEKs in place on first use. The authorization server
  accepts a previous signing key (`VAULT_OIDC_PREVIOUS_JWK`) for verification only and
  publishes both in the JWKS. Legacy AAD items are rewrapped once at boot and the fallback is
  gone; `items.aad_version` records the state.
- **Proxy trust is explicit, per header.** Client IPs come from `Fly-Client-IP` only when the
  process runs on Fly (`FLY_APP_NAME`), from the last `X-Forwarded-For` hop only on Fly or
  behind a proxy the deployer opted into (`VAULT_TRUST_PROXY=1`), from `CF-Connecting-IP` only
  when that peer is inside `VAULT_TRUSTED_PROXY_CIDRS`, and from the socket otherwise. A Fly
  header off Fly is client input and is ignored.
- **Bounded connector.** Responses are capped at 1 MiB of raw bytes, premature close fails the
  call instead of hanging it, and only port 443 is dialled.
- **Remove what is not finished.** The AgentPass stub is deleted rather than shipped
  half-built; it can return as a designed feature with its own ADR.

## Consequences

- Deploys that omit `VAULT_DEPLOY_PLANE` or set `VAULT_AUTH_MODE=test` exit 78. The CI image
  job checks the refusal path on every build.
- A leftover `VAULT_BOOTSTRAP_TOKEN` on a plane is ignored unless
  `VAULT_BOOTSTRAP_ALLOW_PLANE=1`; boot logs `bootstrap_token_ignored` and keeps serving.
  The intended end state is no bootstrap token on production.
- Local users update their MCP client configuration to the model bearer printed by
  `vault serve`.
- Existing prompt grants behave differently on a non-2xx origin response: the model is told
  to ask again. Console copy and docs say so.
- KEK and signing-key rotation follow the runbooks in `docs/ops/kek-rotation.md` and
  `docs/ops/oidc-key-rotation.md` and need no maintenance window.
- CI deploy secrets move to GitHub environments (`staging`, `production`, `backup`), so a
  pull request from a fork cannot read them.

## Alternatives considered

- Keep the retry-on-any-non-2xx behaviour for prompt grants. Rejected: an origin that returns
  429 or 500 has already received the credential, so the grant was spent.
- Keep the legacy AAD fallback indefinitely. Rejected: a permanent fallback means an item
  moved between orgs still decrypts, which is the property the bound AAD exists to remove.
- Rotate keys offline only. Rejected: the hosted plane is expected to run continuously and a
  stop-the-world rewrap would become a reason never to rotate.
