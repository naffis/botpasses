# 0002. Public origins are botpasses.com

- Status: accepted
- Date: 2026-08-31
- Supersedes: origin hosts in [0001](0001-botpasses-identity.md)

## Context

ADR 0001 named the product Botpasses and set public origins to `botpasses.ai`. The owned domain is **botpasses.com**. `package.json` `homepage` already pointed at `https://botpasses.com`. Shipping `.ai` in brand constants, MCP collect URLs, CLI login help, and the cutover runbook would point operators and clients at the wrong zone.

Product name, `VAULT_*` env prefix, and Fly app names in 0001 still hold. Clerk is not used (see [0003](0003-first-party-operator-identity.md) and [0004](0004-same-origin-oauth-as.md)).

## Decision

We will use **botpasses.com** as the public zone. Prod origin is `https://botpasses.com`. Staging is `https://staging.botpasses.com`. `www.botpasses.com` is a Cloudflare 301 to the apex, not a second OAuth resource.

This origin is the OAuth authorization server and resource server. Resend domain is `mail.botpasses.com`. Documented From is `Botpasses <noreply@mail.botpasses.com>` via `VAULT_EMAIL_FROM`.

Canonical constants live in `src/brand.ts` (`STAGING_ORIGIN`, `PRODUCTION_ORIGIN`). Hosted boot (`VAULT_MODE=hosted`) requires `VAULT_PUBLIC_URL` to equal the plane origin. Loopback is only for local tests and `vault serve`. Platform default hostnames are not a public origin: they must not appear in MCP `collect_url`, CLI login, OAuth resource metadata, approval emails, or operator docs.

## Consequences

- Fly secrets `VAULT_PUBLIC_URL` and `VAULT_EMAIL_FROM` must use `.com` (not `.ai`). Set `VAULT_SESSION_SECRET` and `VAULT_OIDC_PRIVATE_JWK`. Unset any leftover Clerk secrets.
- `fly.staging.toml` / `fly.prod.toml` set `VAULT_PUBLIC_URL` to the plane origin so a missing secret cannot emit another hostname.
- Cloudflare DNS, Fly certs, and Resend records are on the `.com` zone. Delete `clerk.*` CNAMEs. DNS is A/AAAA to Fly IPs, not a user-facing hostname on the platform default domain.
- MCP collect URLs and CLI login help default to `.com` via the brand constants. Hosted boot exits 78 if `VAULT_PUBLIC_URL` is missing or is not the plane origin.

## Alternatives considered

- Keep `.ai` in code until DNS exists. Rejected: the owned domain is `.com`; a wrong default poisons MCP clients and operator links.
- Dual-host both TLDs. Extra OAuth resource and certs for no current traffic on `.ai`.
