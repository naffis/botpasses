# 0001. Botpasses product identity

- Status: accepted
- Date: 2026-08-30

## Context

The product shipped as Agent Grant Vault (`agent-vault`, MCP name `AgentVault`, health `agent-grant-vault`) on placeholder hosts. The owned domain is `botpasses.ai`. Operators, MCP clients, and Fly apps need one name. Env vars are already `VAULT_*` in code, tests, and secrets. Deploy tokens on Fly are per-app; renaming toml app names without creating the apps first fails CI with `Could not find App`.

## Decision

We will call the product **Botpasses**. Slug, MCP `serverInfo.name`, and `/health` `product` are `botpasses`. Prod origin is `https://botpasses.ai`. Staging is `https://staging.botpasses.ai`. `www` is a Cloudflare 301 to the apex, not a second OAuth resource.

We will keep the `VAULT_*` process env prefix. We will not add `authorizedParties` on Clerk `verifyToken` (MCP `azp` is not the app origin).

We will create Fly apps `botpasses-staging` and `botpasses-prod`, copy secrets (including reused Neon `DATABASE_URL`), and confirm the GitHub `FLY_API_TOKEN` can deploy those names **before** pushing renamed `fly.*.toml` files.

## Consequences

- CLI dual bin (`botpasses` + `vault`) until npm publish; docs still show `npx vault`.
- Default sqlite home is `$HOME/.botpasses`. There is no auto-migrate from `~/.agent-vault`.
- Two Clerk production instances with grey-cloud FAPI hosts `clerk.botpasses.ai` and `clerk.staging.botpasses.ai`.
- Resend domain `mail.botpasses.ai`; From `Botpasses <noreply@mail.botpasses.ai>` via `VAULT_EMAIL_FROM`.
- GitHub rename to `naffis/botpasses` happens after the first green staging deploy, not before.

## Alternatives considered

- Keep Fly names `agent-vault-*` and only change public DNS. Simpler CI, but the app would still be named agent-vault in Fly and deploy logs.
- Rename env vars to `BOTPASSES_*`. Breaks every secret, workflow, and test for no user-facing gain.
- Put the app on `app.botpasses.ai` with a marketing apex. Extra host and OAuth resource for no current marketing site.
