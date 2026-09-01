# 0003. First-party operator identity

- Status: accepted
- Date: 2026-08-31

## Context

Hosted identity used Clerk session JWTs. A new operator could not get a vault org. Email OTP alone is not MFA (NIST SP 800-63B-4, OWASP ASVS V6).

## Decision

Operator accounts are issued on this origin. Email OTP (8 digits, 10 minutes, scrypt) proves the inbox. TOTP (RFC 6238, SHA-1, 30s) plus hashed backup codes is required before operator APIs, consent, and device approval (`operatorReady`). Sessions are opaque, hashed at rest, `__Host-bp_session` on HTTPS (loopback `bp_session`). CSRF is a signed double-submit cookie (`__Host-bp_csrf` / `bp_csrf`, not HttpOnly). First operator-ready session calls `createOrg("workspace", userId)`.

Passwords, SMS, passkeys, and third-party IdPs are out of scope.

## Consequences

- Env: `VAULT_SESSION_SECRET` (≥32 bytes). No `CLERK_*`.
- HTML at `/sign-in`, `/sign-up`, `/enroll-totp`.
- Bootstrap `VAULT_BOOTSTRAP_TOKEN` remains break-glass and is not listed on Access.

## Alternatives considered

- Clerk or another SaaS IdP. Vendor AS; user lock forbids it.
- Better Auth. Email OTP is not 2FA-gated; MCP plugin is new.
- Email OTP as the only factor. Fails ASVS L2 and NIST.
