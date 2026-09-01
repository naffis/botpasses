# 0001. Botpasses product identity

- Status: accepted (public origins superseded by [0002](0002-botpasses-com-origin.md))
- Date: 2026-08-30

## Context

The product shipped as Agent Grant Vault (`agent-vault`, MCP name `AgentVault`, health `agent-grant-vault`) on placeholder hosts. The owned domain is `botpasses.ai`. Operators, MCP clients, and Fly apps need one name. Env vars are already `VAULT_*` in code, tests, and secrets. Deploy tokens on Fly are per-app; renaming toml app names without creating the apps first fails CI with `Could not find App`.

## Decision

We will call the product **Botpasses**. Slug, MCP `serverInfo.name`, and `/health` `product` are `botpasses`. Prod origin is `https://botpasses.ai`. Staging is `https://staging.botpasses.ai`. `www` is a Cloudflare 301 to the apex, not a second OAuth resource.

We will keep the `VAULT_*` process env prefix. Operator identity and the MCP authorization server are first-party on this origin (see [0003](0003-first-party-operator-identity.md) and [0004](0004-same-origin-oauth-as.md)). Clerk FAPI is not used.

We will create Fly apps `botpasses-staging` and `botpasses-prod`, copy secrets (including reused Neon `DATABASE_URL`), and confirm the GitHub `FLY_API_TOKEN` can deploy those names **before** pushing renamed `fly.*.toml` files.

## Consequences

- CLI dual bin (`botpasses` + `vault`) until npm publish; docs still show `npx vault`.
- Default sqlite home is `$HOME/.botpasses`. There is no auto-migrate from `~/.agent-vault`.
- Clerk FAPI hosts are retired. Sessions are `__Host-` cookies issued by this origin.
- Resend domain `mail.botpasses.ai`; From `Botpasses <noreply@mail.botpasses.ai>` via `VAULT_EMAIL_FROM`.
- GitHub rename to `naffis/botpasses` was planned after the first green staging deploy. It was executed 2026-08-30 at operator request; live staging was still blocked on Fly/DNS.

## Alternatives considered

- Keep Fly names `agent-vault-*` and only change public DNS. Simpler CI, but the app would still be named agent-vault in Fly and deploy logs.
- Rename env vars to `BOTPASSES_*`. Breaks every secret, workflow, and test for no user-facing gain.
- Put the app on `app.botpasses.ai` with a marketing apex. Extra host and OAuth resource for no current marketing site.
