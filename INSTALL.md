# Installing Botpasses

Botpasses runs in two modes. The local CLI keeps a SQLite vault on your machine. The hosted service is what `botpasses.com` runs. Both live in this repository.

## Local CLI

Requirements: Node.js 22.14 or newer.

```bash
git clone https://github.com/naffis/botpasses.git
cd botpasses
npm ci
export VAULT_HOME="$PWD/.botpasses"
npx vault init
```

`vault init` creates the vault directory, the SQLite schema, and a master key. Store a credential, approve an agent, and inject it into a child process:

```bash
printf '%s' 'sk_test_example_not_real' | npx vault set STRIPE_KEY
npx vault grant --secret STRIPE_KEY --agent invoicer --tool stripe --once
npx vault run --with STRIPE_KEY --agent invoicer --tool stripe -- node -e 'console.log(Boolean(process.env.STRIPE_KEY))'
```

The CLI reference is in [README.md](README.md#cli). The npm package is not published yet, so use `npx vault` from this checkout.

## Hosted account

Create an account at https://botpasses.com/sign-up (staging: https://staging.botpasses.com). You confirm an email code, enroll an authenticator app, and then store credentials in the console. Connect an agent from the Agents panel or by adding `https://botpasses.com/mcp` as a remote MCP server in your client. The docs at https://botpasses.com/docs cover each client.

## Running the hosted service yourself

See the deploy section of [README.md](README.md#hosted-deploy-fly--neon--cloudflare) and the runbooks under [docs/ops](docs/ops). The short version:

1. A Postgres database (Neon in production) reachable as `DATABASE_URL`, plus `DATABASE_URL_DIRECT` for migrations.
2. Secrets listed in `.env.example` under "Hosted", including `VAULT_SESSION_SECRET`, `VAULT_OIDC_PRIVATE_JWK`, and either `VAULT_KEK` or the KMS-wrapped pair.
3. Build the site once (`npm run site:build`), then `VAULT_MODE=hosted npm run hosted`.

## Development

```bash
npm ci
npm run site:build
npm test
npm run typecheck
npm run lint
```

`npm test` reads the built site under `site/dist`, so build the site first on a fresh clone. Postgres-only tests run when `DATABASE_URL` points at a Postgres 16 database; CI provides one.
