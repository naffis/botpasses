# Plan: Hosted-dev plane and portable self-host

Canonical interactive plan: Cursor CreatePlan **Hosted-dev and portable store**. Topology: [.loadout/tasks/hosted-dev-portable/TASK.md](../../.loadout/tasks/hosted-dev-portable/TASK.md).

## Review changelog (2026-09-10 review-plan)

P0/P1 applied in this file and the CreatePlan twin. Do not implement from the pre-review text.

- **P0 — `dev` on a Fly Machine.** `VAULT_DEPLOY_PLANE=dev` plus `FLY_APP_NAME` would open sqlite-hosted on ephemeral disk. Locked R-15 / D-07: that pair is exit 78. Self-host on Fly uses `staging` or `production` plus Postgres.
- **P0 — laptop `/robots.txt` must not advertise botpasses.com.** [`robotsTxt("production")`](../../src/hosted/http-util.ts) emits the first-party sitemap. `dev` uses the staging robots/noindex path (D-08, R-16). Widen `hostedPageHeaders` / `robotsTxt` to `DeployPlane`.
- **P0 — hosted loopback still sends vendors to port 8888.** [`chooseRedirect`](../../src/hosted/providers/user-oauth.ts) and [`test/providers.test.ts`](../../test/providers.test.ts) 203–212 return `http://127.0.0.1:8888/callback` when `publicUrl` is loopback. D-05 without this change leaves user-connect dead on hosted-dev. Locked R-17: hosted `chooseRedirect` never accepts `LOOPBACK_REDIRECT`. CLI vault-serve keeps 8888.
- **P0 — missing `site/dist` on `dev`.** [`http.ts`](../../src/hosted/http.ts) already serves `/console` at `/` when `siteRoot` is unset (line 368). `startHosted` must pass `undefined`, not a missing path. R-20.
- **P1 — `hostedKekBootError` treats every named plane as Fly/KMS.** Once `dev` is a `DeployPlane`, the `if (plane)` branch applies. Locked: `dev` uses the raw-only path (R-04); `usedRawKekFallback` is staging/production only (R-14).
- **P1 — AC-06 / AC-08 / AC-12 were either/or.** Locked: AC-06 is `createDevMailer` plus `OperatorIdentity.sendOtp` on a captured stream. AC-08 is `openHostedStore`. AC-12 is `hosted-dev --check` plus extracted `buildHostedDevEnv`. No subprocess listen.
- **P1 — secrets.json mode and port match.** R-18: write mode `0o600`. `VAULT_PUBLIC_URL` host `127.0.0.1` and port equal `PORT` / `VAULT_PORT` (default 8788).
- **P1 — OTP vs OWASP.** Production `logVaultEvent` still must not contain the code ([OWASP MFA cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)). On `dev`, stderr is the mail transport, not that log. R-19.
- **P1 — shared trunk.** Conversation start had dirty `test/site-content.test.ts` and `test/site-copy.test.ts`. A7: if those paths are conflicted or mid-edit, stop and ask.
- **P0 — `dev` bind default is all interfaces.** [`startHosted`](../../src/hosted/main.ts) uses `VAULT_BIND_HOST ?? "0.0.0.0"`. A `dev` process started without the script (or a script that forgets the bind) listens on the LAN with HTTP cookies and OTP. Locked R-21 / D-10: plane `dev` defaults to `127.0.0.1` when `VAULT_BIND_HOST` is unset. Staging/production stay `0.0.0.0`. Explicit `0.0.0.0` on `dev` remains allowed. [CWE-1327](https://cwe.mitre.org/data/definitions/1327.html).
- **P0 — leftover `DATABASE_URL`.** Operators keep a Neon URL in the shell for `npm run test:pg`. If `buildHostedDevEnv` copies `process.env`, `hosted:dev` opens that Postgres with a laptop raw KEK. Locked R-22 / D-11: the builder is an allowlist. It does not copy `DATABASE_URL` unless `--postgres` or `VAULT_HOSTED_DEV_DATABASE_URL` is set. `openHostedStore` still honors `DATABASE_URL` when the operator sets it on purpose (Compose).

## 1. Summary

- Problem: Running the multi-user hosted product on a laptop looks like reproducing botpasses.com (Neon, Fly, KMS, Resend). Self-host docs say "your origin" and "Neon or equivalent," but [`src/brand.ts`](../../src/brand.ts) and [`src/hosted/boot.ts`](../../src/hosted/boot.ts) require a botpasses.com `VAULT_PUBLIC_URL`, a `DATABASE_URL`, and refuse SQLite. The local CLI already uses SQLite and does not need any of that.
- Outcome: `npm run hosted:dev` boots the hosted kernel on loopback with a SQLite hosted store, a raw KEK, and OTP codes printed in the terminal. Self-host on any Postgres 16 and any `https` origin. First-party staging/production stay pinned to botpasses.com hostnames. Neon, Fly, AWS KMS, Cloudflare, R2, and Resend remain the reference stack, not the runtime interface.
- Approach: Add `VAULT_DEPLOY_PLANE=dev`. Wire `startHosted` to `openHostedSqlite` when that plane has no `DATABASE_URL`. Relax `publicOriginError` for custom `https` origins and for loopback on `dev` only. Split process plane from vault environment so `dev` is not a `VaultEnvName`. Generate laptop secrets in gitignored `.botpasses-hosted/`. Name capabilities in docs. No new database dialect and no production SQLite.

## 2. Scope

### In scope

- `DeployPlane` includes `dev`. `deployPlaneRaw` / `hostedDeployPlane` accept it. `DEPLOY_PLANE_REQUIRED` names `staging`, `production`, or `dev`. Unset or unknown names stay exit 78. `FLY_APP_NAME` set with plane `dev` is exit 78.
- Hosted-dev boot: optional `DATABASE_URL` (SQLite hosted file when unset), required raw `VAULT_KEK`, loopback `VAULT_PUBLIC_URL` (`127.0.0.1` or `localhost` only; not `[::1]`), session secret, OIDC JWK. `VAULT_HOME` still refused. Wrapped KEK and `VAULT_KEK_REQUIRE_KMS=1` refused on `dev`. `hostedKekBootError` uses the raw-only branch for `dev`.
- `site/dist` not required on `dev`. `startHosted` passes `siteRoot: undefined` when `index.html` is absent so `/` is the console ([`src/hosted/http.ts`](../../src/hosted/http.ts) 368).
- `npm run hosted:dev` via `scripts/hosted-dev.ts`: create `.botpasses-hosted/`, persist generated secrets once, bind `127.0.0.1:8788`, print OTP codes, start `startHosted`.
- Terminal mailer on `dev` when `RESEND_API_KEY` is unset. Prints recipient and 8-digit OTP (and approval subjects). Never installed on staging/production.
- `startHosted` derives `secureCookies` and loopback Host allow from the public URL (`https` → Secure cookies; `http` loopback → not Secure). Stop hardcoding `secureCookies: true` and `allowLoopback: false`.
- Origin policy: first-party hosts still must match the plane. Custom `https` origins allowed on staging/production (self-host). Loopback allowed only when `allowLoopback` is true and (no plane or plane is `dev`). Platform-default hostnames stay refused.
- `VAULT_KMS_APP_ID` is the KMS EncryptionContext `app` value; `FLY_APP_NAME` remains the fallback. Wrapped KEK without either is exit 78.
- Connect redirect on a hosted process is always `{origin}/connect/callback`. `chooseRedirect` rejects `http://127.0.0.1:8888/callback` for every hosted public URL, including loopback. That URI stays the local CLI vault-serve callback only (`assertRedirectUri` / docs for `vault serve`). Update [`test/providers.test.ts`](../../test/providers.test.ts).
- `dev` robots and `hostedPageHeaders` follow staging (noindex; robots without the botpasses.com sitemap). Production robots stay first-party only.
- Docs: self-hosting capability table, README local hosted-dev, `.env.example`, AGENTS.md, changelog, ADR 0010 amending ADR 0002 for `dev` and custom origins. Boot error strings say "Postgres" not "Neon pooled."
- Tests and site-content assertions that encode the old pin.
- Plane `dev` binds `127.0.0.1` when `VAULT_BIND_HOST` is unset (`bindHostForPlane`). Staging/production stay `0.0.0.0`.
- `buildHostedDevEnv` is an allowlist. It does not copy parent `DATABASE_URL`, `VAULT_HOME`, or `FLY_APP_NAME`. `--postgres` / `VAULT_HOSTED_DEV_DATABASE_URL` is the opt-in Postgres path.

### Non-goals (with rationale)

- MySQL, MariaDB, MongoDB, D1, LiteFS, or a third `VaultStore` dialect. [`VaultStore`](../../src/store/types.ts) already has Postgres and sqlite-hosted. Infisical ships Postgres only. Extra dialects do not unlock self-host.
- Production hosted SQLite. The 2026-08-30 grant-vault plan rejected it (no PITR; LiteFS can lose writes). `dev` is the only plane that opens sqlite-hosted.
- Merging the CLI vault schema (`src/vault.ts` / `VAULT_HOME`) with sqlite-hosted. Different keys, AAD, and tenancy.
- Azure Key Vault, GCP KMS, or a generic SMTP provider. `KekProvider` and `EmailSender` already exist; Resend stays the first hosted sender; `dev` uses the log mailer.
- Changing the first-party Fly + Neon + R2 + Cloudflare production topology.
- Multi-machine / moving in-memory TOTP enroll and per-IP limiters into the store.
- Docker Compose as the only laptop path. Compose Postgres remains valid by setting `DATABASE_URL` on `dev`.

### Assumptions (labeled; must not block implementation)

- A1: The laptop goal is the hosted console, identity, and OAuth AS, not only `vault serve`. The CLI path already works.
- A2: Self-hosters may publish a non-botpasses.com `https` origin. ADR 0002 continues to pin first-party hostnames.
- A3: `npm test` still requires `site/dist` (pretest). The hosted-dev *process* does not.
- A4: No new runtime npm dependency. Secret file I/O is `node:fs` plus `JSON.parse`.
- A5: Shared trunk may have other agents' dirty files. This change does not restore or stash.
- A6: Default OAuth client environment on `dev` is `staging` (both vault environments remain listable).
- A7: If `test/site-content.test.ts`, `test/site-copy.test.ts`, `src/hosted/http.ts`, or `src/hosted/http-cors.ts` is conflicted or clearly another agent's unfinished edit, stop and ask. Do not merge by guessing. Sibling CORS/visual WIP was present at review time; T-01/T-02 must keep those edits. T-05 appends changelog Unreleased; it does not replace sibling entries.
- A8: Bootstrap on `dev` matches staging: the token is ignored unless `VAULT_BOOTSTRAP_ALLOW_PLANE=1`. The `dev` mailer is the sign-in path.

### Open questions

<!-- Must be EMPTY at delivery. -->

## 3. Current state (in-repo, evidence-based)

- What exists today:
  - Local CLI: SQLite at `$VAULT_HOME`, `vault serve` on loopback, master key. No Neon.
  - Hosted: `VAULT_MODE=hosted` → `assertHostedBoot` → `PostgresStore.open(DATABASE_URL)` in [`src/hosted/main.ts`](../../src/hosted/main.ts). Refuses `VAULT_HOME`. `publicOriginError(..., { plane, allowLoopback: false })` requires the plane's botpasses.com origin ([`src/brand.ts`](../../src/brand.ts) 50–86, [`src/hosted/boot.ts`](../../src/hosted/boot.ts) 234–285).
  - `DeployPlane` is only `staging | production`. `HostedKernel.deployPlane` is the same union and is used as a `VaultEnvName` default in [`src/hosted/oauth-clients.ts`](../../src/hosted/oauth-clients.ts) 317–327 and [`defaultEnvironmentForDeployPlane`](../../src/hosted/deploy-plane.ts) (returns `plane`).
  - sqlite-hosted implements `VaultStore` ([`src/store/sqlite-hosted.ts`](../../src/store/sqlite-hosted.ts)). Almost all hosted tests use it. `test/store-parity.test.ts` runs the same kernel against sqlite always and Postgres when `DATABASE_URL` is set.
  - `createHostedServer` already derives `allowLoopback` and `secureCookies` from the public URL ([`src/hosted/http.ts`](../../src/hosted/http.ts) 111–115). `startHosted` overrides both to production values (lines 110, 119, 133).
  - Email is optional. Without `sendEmail`, OTP is stored and the operator never sees the code ([`src/hosted/operator-identity.ts`](../../src/hosted/operator-identity.ts) 266–272).
  - Connect: `defaultConnectRedirect` returns `http://127.0.0.1:8888/callback` when `publicUrl` is loopback ([`src/hosted/providers/connect-redirect.ts`](../../src/hosted/providers/connect-redirect.ts) 13–16). That URI is the CLI vault, not the hosted process.
  - KMS context `app` is `FLY_APP_NAME` only ([`src/hosted/kms.ts`](../../src/hosted/kms.ts) 96–97).
  - `.gitignore` already ignores `*.sqlite` and `.botpasses/`. It does not name `.botpasses-hosted/`.
- Gaps / constraints:
  - `hostedBootError` cannot succeed for loopback or sqlite. AC-11 ([`test/hosted.test.ts`](../../test/hosted.test.ts) 604) asserts `VAULT_HOME` refuse.
  - `test/brand.test.ts` 115–131 asserts `https://example.com` is refused.
  - `HostedHttpOpts.deployPlane` and several MCP helpers are typed `"staging" | "production"`.
  - Adding `dev` to `DeployPlane` without splitting vault-env defaults makes TypeScript assign `"dev"` to `VaultEnvName`.
- Reusable components: `openHostedSqlite`, `VaultStore`, `EmailSender`, `KekProvider` / `LocalKekProvider`, `createHostedServer`, `testOidcPrivateJwk` pattern (`generateKeyPairSync("rsa")`), `hostedBootError` / `assertHostedBoot`, identity harness mailer in [`test/identity-harness.ts`](../../test/identity-harness.ts).
- Files read (path — why): `src/brand.ts` (origin pin); `src/hosted/boot.ts` (exit 78); `src/hosted/main.ts` (store + cookies); `src/hosted/kernel.ts` (deployPlane type); `src/hosted/deploy-plane.ts`; `src/hosted/kms.ts`; `src/hosted/email.ts`; `src/hosted/http.ts`; `src/hosted/providers/connect-redirect.ts`; `src/store/sqlite-hosted.ts`; `src/store/postgres.ts` (generic `pg`, PgBouncer comment); `src/cli.ts` (hosted serve, login origin); `test/hosted.test.ts`; `test/brand.test.ts`; `test/infra-hardening.test.ts`; `site/src/content/docs/self-hosting.md`; `docs/adr/0002-botpasses-com-origin.md`; `docs/adr/0007-kms-wrapped-kek.md`; `docs/plans/2026-08-30-grant-vault-product.md`; `.env.example`; `package.json`; `.gitignore`; `AGENTS.md`; `CHANGELOG.md`.

## 4. External research

### Questions investigated

1. How do comparable secret products split laptop vs production stores?
2. What does "portable across infrastructures" mean without a polyglot ORM?
3. Is SQLite acceptable for a multi-user grant vault in production?
4. May an OAuth/OIDC authorization server use `http://127.0.0.1` in development?
5. How should email OTP work when there is no mail vendor without writing codes into production logs?
6. What happens if a laptop plane is pointed at a cloud hostname?
7. How do self-host products bind the public origin to OAuth callbacks?

### Sources consulted

- The Twelve-Factor App — Backing services — https://12factor.net/backing-services — Datastores and SMTP are attached resources (URL in config). Swap Neon for RDS or local Postgres without code changes. Does not require supporting every engine.
- Infisical self-hosting requirements — https://infisical.com/docs/self-hosting/configuration/requirements — PostgreSQL is the only supported database (14+; 16 tested). No SQLite production path.
- Infisical environment variables — https://infisical.com/docs/self-hosting/configuration/envars — `DB_CONNECTION_URI` is a Postgres URL. Redis is a second backing service; Botpasses does not need Redis.
- HashiCorp Vault storage — https://developer.hashicorp.com/vault/docs/configuration/storage — File backend is for single-server non-production. Production uses integrated storage or an external backend.
- RFC 8252 §7.3 / §8.3 — https://www.rfc-editor.org/rfc/rfc8252.html — Loopback `http` redirect URIs are acceptable because the request never leaves the device. Prefer `127.0.0.1` over `localhost`.
- OpenID Connect Core 1.0 §2 (Issuer Identifier) — https://openid.net/specs/openid-connect-core-1_0.html#IssuerIdentifier — Issuer is a case-sensitive URL; metadata and tokens must use that same issuer. A self-host origin must be the configured `VAULT_PUBLIC_URL`, not a hardcoded botpasses.com.
- Neon connection pooling — https://neon.com/docs/connect/connection-pooling — `-pooler` is PgBouncer. Startup parameters such as `options` / `statement_timeout` are refused. That constraint is PgBouncer-generic (Supabase pooler, RDS Proxy), already handled in `PostgresStore.poolOptions`.
- Fly LiteFS — https://fly.io/docs/litefs/ — Async replication can lose writes. Already rejected for hosted durability in `docs/plans/2026-08-30-grant-vault-product.md`.
- OWASP Multifactor Authentication Cheat Sheet — OTP handling — https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html — OTP implementations must not log OTP values. Adapt: `logVaultEvent` / `otp_sent` stay code-free. The `dev` mailer writes the code to stderr as the delivery channel (the inbox), never as a structured vault event.
- MDN `Set-Cookie` / `__Host-` prefix — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie — `__Host-` cookies require `Secure` from an HTTPS origin. Loopback HTTP must use `bp_session` / `bp_csrf` (already how `secureCookies: false` works in [`operator-identity.ts`](../../src/hosted/operator-identity.ts) 91–95).
- GitLab `external_url` — https://docs.gitlab.com/omnibus/settings/configuration/ — Self-host public origin is config; OAuth callbacks are derived from that URL. Same job as `VAULT_PUBLIC_URL`.
- CWE-1327 Binding to an Unrestricted IP Address — https://cwe.mitre.org/data/definitions/1327.html — `0.0.0.0` is the convenient default for containers, not laptops. `dev` must default to `127.0.0.1` in `startHosted`, not only in the npm script.
- Fly Machine runtime environment — https://fly.io/docs/machines/runtime-environment/ — `FLY_APP_NAME` is injected on every Machine. `dev` plus that var is a reliable "this is Fly" signal (R-15).
- Prisma env-file warning — https://www.prisma.io/docs/orm/more/dev-environment/environment-variables — a leftover production `DATABASE_URL` in the process env is how local tools hit the wrong database. `dev` script uses an allowlist.

### State of the art / common practice

Secrets and identity products that inject at the server treat Postgres as the production store and either an embedded file or a local Postgres as the laptop store. They do not advertise MySQL/Mongo as a portability feature. Portability is "any host that speaks this protocol," not "every storage engine."

### Pitfalls & anti-patterns to avoid

- Shipping sqlite-hosted when `VAULT_DEPLOY_PLANE` is staging or production (data-loss / no PITR).
- Hardcoding `Secure` cookies on `http://127.0.0.1` (browsers drop them; identity tests already use `secureCookies: false`).
- Using `dev` as a `VaultEnvName` (OAuth clients would get environment `dev`, which is not a column value).
- Printing OTP on staging/production if Resend is unset.
- Leaving connect redirect at port 8888 when the hosted AS is on 8788 ([`test/providers.test.ts`](../../test/providers.test.ts) 203).
- Serving production `robots.txt` on `dev` (first-party sitemap on a laptop).
- Setting `VAULT_DEPLOY_PLANE=dev` on Fly to skip Neon.
- Putting a Neon project slug or a home path in tests or docs.
- Calling `logVaultEvent` with the OTP digits.

### Implications for this plan

- Adopt 12-factor attached resources: `DATABASE_URL` is any Postgres 16; mailer is `EmailSender`; KMS app id is config.
- Adopt Infisical's "Postgres only" production stance; reject extra engines.
- Adopt Vault's "file is non-prod" stance as `dev` + sqlite-hosted.
- Adopt RFC 8252 loopback `http` for the `dev` origin; default bind `127.0.0.1`.
- Adapt OIDC issuer to equal the configured origin (already true in `createOauthProvider({ issuer: publicUrl })` once origin policy allows it). GitLab `external_url` is the same pattern.
- Adapt OWASP "do not log OTP": `dev` stderr delivery is allowed; structured logs are not.
- Adopt MDN `__Host-` rules: `dev` HTTP cannot use `__Host-` cookies.
- Reject LiteFS / production SQLite (already a repo invariant).
- Reject `dev` on any process that has `FLY_APP_NAME`.
- Adopt CWE-1327: `dev` bind default is loopback inside `startHosted`.
- Adopt Prisma's "wrong DATABASE_URL in the shell" warning: `buildHostedDevEnv` is an allowlist.

## 5. Requirements

### Functional (EARS)

- **R-01.** When `VAULT_MODE=hosted` and `VAULT_DEPLOY_PLANE=dev` and `DATABASE_URL` is unset and `VAULT_HOME` is unset and raw `VAULT_KEK`, `VAULT_SESSION_SECRET` (≥32 bytes), `VAULT_OIDC_PRIVATE_JWK`, and a loopback `VAULT_PUBLIC_URL` are set, the process shall boot ( `hostedBootError` is undefined ) and `startHosted` shall open sqlite-hosted at `VAULT_HOSTED_SQLITE` or `.botpasses-hosted/hosted.sqlite`.
- **R-02.** When `VAULT_DEPLOY_PLANE` is `staging` or `production`, `hostedBootError` shall still require `DATABASE_URL`, refuse `VAULT_HOME`, refuse loopback `VAULT_PUBLIC_URL`, and require `site/dist/index.html`.
- **R-03.** When `VAULT_DEPLOY_PLANE=dev` and `DATABASE_URL` is a reachable Postgres URL, `startHosted` shall open `PostgresStore` (same as today) and shall not open sqlite-hosted.
- **R-04.** When `VAULT_DEPLOY_PLANE=dev` and `VAULT_KEK_WRAPPED` or `VAULT_KEK_REQUIRE_KMS=1` is set, boot shall exit 78.
- **R-05.** When `VAULT_DEPLOY_PLANE` is `staging` or `production` and `VAULT_PUBLIC_URL` is `https` and the host is not a first-party botpasses.com origin and not a platform-default hostname, `publicOriginError` shall be undefined. First-party hosts shall still match `originForPlane(plane)`.
- **R-06.** When `VAULT_PUBLIC_URL` uses a platform-default hostname (detected without storing the literal `fly.dev` string in product docs), `publicOriginError` shall return an error on every plane.
- **R-07.** When the hosted process public URL starts with `https:`, cookies and oidc-provider shall use `secureCookies=true`. When it is loopback `http:`, they shall use `secureCookies=false` and `hostAllowed` shall accept loopback Host.
- **R-08.** When plane is `dev` and `RESEND_API_KEY` is unset, `startHosted` shall install a mailer that writes the recipient and OTP (or approval subject) to stderr. When `RESEND_API_KEY` is set, Resend remains the mailer.
- **R-09.** When plane is `staging` or `production` and `RESEND_API_KEY` is unset, no log mailer shall be installed (same as today).
- **R-10.** `environmentsForDeployPlane("dev")` and `("production")` shall be `staging` and `production`. `environmentsForDeployPlane("staging")` shall be `staging` only. `defaultEnvironmentForDeployPlane("dev")` shall be `staging`. `defaultEnvironmentForDeployPlane` shall never return `dev`.
- **R-11.** `selectKekProvider` / `vault kek-wrap` shall use `VAULT_KMS_APP_ID` if set, else `FLY_APP_NAME`. Missing both with a wrapped KEK is exit 78.
- **R-12.** `defaultConnectRedirect` on a hosted public URL shall be `{origin}/connect/callback` even when the origin is loopback. `LOOPBACK_REDIRECT` (`http://127.0.0.1:8888/callback`) remains valid only for the local CLI plane.
- **R-13.** `npm run hosted:dev` shall create `.botpasses-hosted/` if needed, write `secrets.json` once (kek, session secret, approval HMAC, OIDC JWK), refuse to print those values, set the `dev` env, and call `startHosted`. A second run shall reuse the file.
- **R-14.** `usedRawKekFallback` / `kek_raw_fallback` shall fire only when `VAULT_DEPLOY_PLANE` is `staging` or `production` and a raw KEK is in use. Plane `dev` shall not emit it.
- **R-15.** When `VAULT_DEPLOY_PLANE=dev` and `FLY_APP_NAME` is non-empty, `hostedBootError` shall return an error. Self-host on Fly uses `staging` or `production` plus Postgres.
- **R-16.** `robotsTxt("dev")` and `hostedPageHeaders("dev", …)` shall match staging behavior (noindex; robots without the botpasses.com sitemap). `robotsTxt("production")` is unchanged.
- **R-17.** `defaultConnectRedirect` and `chooseRedirect` on a hosted public URL shall use `{origin}/connect/callback`. `chooseRedirect` shall throw when the requested URI is `LOOPBACK_REDIRECT`, including when `publicUrl` is loopback.
- **R-18.** `scripts/hosted-dev.ts` shall write `.botpasses-hosted/secrets.json` with mode `0o600`. `VAULT_PUBLIC_URL` shall be `http://127.0.0.1:<port>` where `<port>` is `PORT` or `VAULT_PORT` or `8788`.
- **R-19.** `createDevMailer` shall write the recipient and OTP (or approval subject) only to the supplied write stream (default stderr). `logVaultEvent` fields shall not include the OTP digits on any plane.
- **R-20.** When plane is `dev` and `site/dist/index.html` is absent, `hostedBootError` shall not fail for the missing file, and `startHosted` shall pass `siteRoot: undefined` to `createHostedServer`.
- **R-21.** When plane is `dev` and `VAULT_BIND_HOST` is unset, `startHosted` shall bind `127.0.0.1`. When plane is `staging` or `production` and `VAULT_BIND_HOST` is unset, it shall bind `0.0.0.0`. An explicit `VAULT_BIND_HOST` on any plane wins.
- **R-22.** `buildHostedDevEnv` shall build `dev` env from an allowlist (mode, plane, public URL, bind, secrets, optional `VAULT_HOSTED_SQLITE`). It shall not copy parent `DATABASE_URL`, `VAULT_HOME`, or `FLY_APP_NAME`. `--postgres` (or `VAULT_HOSTED_DEV_DATABASE_URL`) is the only way the script sets `DATABASE_URL`.

### Non-functional

- No new runtime dependencies.
- Expand-only schema: no migration. sqlite-hosted already applies `HOSTED_SCHEMA_SQLITE`.
- Boot messages and docs name capabilities (Postgres, KEK, mailer, origin). First-party vendor names stay in the reference-stack section and the privacy page.
- Operator identifiers stay out of git.

### Acceptance criteria (Given/When/Then)

- **AC-01.** Given env `VAULT_MODE=hosted`, `VAULT_DEPLOY_PLANE=dev`, loopback public URL, raw 32-byte KEK, 32-byte session secret, valid RS256 JWK, no `DATABASE_URL` / `VAULT_HOME`, and `VAULT_SITE_ROOT` pointing at an empty temp dir, when `hostedBootError` runs, then it returns `undefined`.
- **AC-02.** Given the AC-01 env plus `VAULT_HOME=/tmp/x`, when `hostedBootError` runs, then the message matches `/VAULT_HOME/`.
- **AC-03.** Given a staging env that today passes AC-11 (DATABASE_URL, no VAULT_HOME, staging origin), when `hostedBootError` runs, then it is still `undefined`. Given that env plus loopback public URL, then it errors. Given that env plus missing `DATABASE_URL`, then it errors.
- **AC-04.** Given `publicOriginError("https://example.com", { plane: "production", allowLoopback: false })`, when evaluated, then it is `undefined`. Given the same URL with `plane: "staging"` and first-party production origin swapped, then the first-party mismatch still errors. Given `https://example.com` with `plane: "dev"`, then it errors (dev is loopback-only).
- **AC-05.** Given a constructed platform-default origin (join `fly` + `dev` as in `test/brand.test.ts`), when `publicOriginError` runs on any plane, then it errors.
- **AC-06.** Given `createDevMailer` writing to a captured stream and `OperatorIdentity.sendOtp("op@example.com", "127.0.0.1")`, when the call returns, then the stream contains an 8-digit code, `verifyOtp` with that code succeeds, and no `logVaultEvent` payload in the test spy contains that code.
- **AC-07.** Given `createHostedServer` with `publicUrl=http://127.0.0.1:0` and `secureCookies` omitted (derived), when a sign-in Set-Cookie is issued, then the cookie name is `bp_session` (not `__Host-bp_session`) and the header has no `Secure`.
- **AC-08.** Given plane `dev`, no `DATABASE_URL`, and `VAULT_HOSTED_SQLITE` pointing at a temp path, when `openHostedStore(env)` runs, then that file exists and `store.ping()` succeeds. A second call with `DATABASE_URL` set returns a `PostgresStore` (skip the Postgres assertion when `DATABASE_URL` is unset in CI).
- **AC-09.** Given `defaultConnectRedirect("http://127.0.0.1:8788")`, when called, then the result is `http://127.0.0.1:8788/connect/callback`.
- **AC-10.** Given `defaultEnvironmentForDeployPlane("dev")`, when called, then the result is `"staging"`. Given `persistIssuedAccess` without an environment argument on a kernel whose process plane is `dev`, when it writes a client, then `clients.environment` is `staging`.
- **AC-11.** Existing AC-11 (`VAULT_HOME` refuse on staging) still passes.
- **AC-12.** Given a temp directory as cwd, when `buildHostedDevEnv` plus `hosted-dev --check` runs, then `hostedBootError` on the produced env is `undefined`, `secrets.json` mode is `0o600`, stderr does not contain the KEK hex, and no listen socket is opened.
- **AC-13.** Given the AC-01 env plus `FLY_APP_NAME=botpasses-staging`, when `hostedBootError` runs, then the message matches `/FLY_APP_NAME/` or `/dev/`.
- **AC-14.** Given `robotsTxt("dev")`, when read, then it does not contain `botpasses.com`. Given `hostedPageHeaders("dev", { html: false })`, then `x-robots-tag` is `noindex, nofollow`.
- **AC-15.** Given `chooseRedirect(spotify, "http://127.0.0.1:8788")`, when called, then the result is `http://127.0.0.1:8788/connect/callback`. Given the same public URL and requested `http://127.0.0.1:8888/callback`, then it throws `/redirect_uri/`.
- **AC-16.** Given `buildHostedDevEnv` with `PORT=9999`, when the env is built, then `VAULT_PUBLIC_URL` is `http://127.0.0.1:9999`.
- **AC-17.** Given plane `dev` and unset `VAULT_BIND_HOST`, when `bindHostForPlane` (extracted from `startHosted`) runs, then the result is `127.0.0.1`. Given plane `staging` and unset `VAULT_BIND_HOST`, then the result is `0.0.0.0`. Given plane `dev` and `VAULT_BIND_HOST=0.0.0.0`, then the result is `0.0.0.0`.
- **AC-18.** Given a parent env with `DATABASE_URL=postgres://example/db`, when `buildHostedDevEnv` runs without `--postgres`, then the produced env has no `DATABASE_URL`. Given `--postgres` and `VAULT_HOSTED_DEV_DATABASE_URL=postgres://local/vault`, then the produced env `DATABASE_URL` is that URL.

### Edge cases & error paths

- `VAULT_DEPLOY_PLANE=dev` + `VAULT_PUBLIC_URL=https://botpasses.com` → exit 78.
- `VAULT_DEPLOY_PLANE=production` + `VAULT_PUBLIC_URL=https://staging.botpasses.com` → exit 78 (first-party mismatch).
- `VAULT_DEPLOY_PLANE=dev` + `VAULT_BIND_HOST=0.0.0.0` is allowed if the operator sets it; the script default is `127.0.0.1`.
- Corrupt `.botpasses-hosted/secrets.json` → script exits 78 with a rewrite instruction, does not overwrite without `--reset` (flag documented; `--reset` replaces the file).
- Postgres open failure on `dev` with `DATABASE_URL` set → same exit 78 path as today.
- Partial listen failure: existing `createShutdown` drain is unchanged.
- Two `hosted:dev` processes on one sqlite file: SQLite may return BUSY. Document one process; do not add a lock daemon.
- `http://[::1]:8788` as `VAULT_PUBLIC_URL` on `dev`: exit 78 (`isLoopbackHost` is `127.0.0.1` and `localhost` only). The script uses `127.0.0.1`.
- `VAULT_DEPLOY_PLANE=dev` + `FLY_APP_NAME` set: exit 78 (R-15).

## 6. Design decisions (mini-ADRs)

### D-01: `dev` is a process plane, not a vault environment

- Context: `HostedKernel.deployPlane` is used as `VaultEnvName`.
- Options: (1) New env var `VAULT_HOSTED_PROFILE=dev` and keep planes as staging/production. (2) Add `dev` to `DeployPlane` and split `defaultEnvironmentForDeployPlane`. (3) Docker Compose Postgres only; no sqlite boot path.
- Decision: (2). One parser stays `deployPlaneRaw`. Vault env defaults to `staging` on `dev`.
- Informed by: current `deploy-plane.ts`; Infisical still uses one Postgres in every profile.
- Consequences: touch kernel, http, oauth-clients, MCP default env helpers, robots/noindex for `dev`.

### D-02: sqlite-hosted on `dev` when `DATABASE_URL` is unset

- Context: User asked to simplify laptop runs with SQLite.
- Options: (1) sqlite-hosted default, Postgres if URL set. (2) Require local Postgres always. (3) Use CLI `VAULT_HOME` schema for hosted.
- Decision: (1). Tests already prove kernel parity on sqlite-hosted. (3) mixes master-key CLI rows with org DEKs.
- Informed by: `openHostedSqlite`; Vault file-backend-is-non-prod; grant-vault plan LiteFS reject.
- Consequences: `startHosted` branches on plane + URL. Staging/production never take this branch.

### D-03: Custom `https` origin on staging/production; loopback only on `dev`

- Context: ADR 0002 pins botpasses.com. Self-host docs contradict the code. CLI `vault login` uses `publicOriginError` without a plane.
- Options: (1) Allow any `https` origin when the host is not first-party and not a platform default. (2) New `VAULT_SELF_HOST=1` flag. (3) Delete self-host docs.
- Decision: (1), plus `dev` requires loopback. CLI with no plane accepts first-party, loopback, or custom `https` (not platform-default). First-party host + plane still must match `originForPlane`.
- Informed by: OIDC issuer = configured URL; 12-factor config; ADR 0002 (amended by ADR 0010, not discarded).
- Consequences: `test/brand.test.ts` changes. Fly tomls keep first-party URLs so our Machines stay pinned.

### D-04: Log mailer on `dev` only

- Context: OTP is stored even when send fails/absent, but the human never sees the code.
- Options: (1) stderr mailer on `dev`. (2) Fixed OTP `00000000` in dev. (3) Require Resend locally.
- Decision: (1). (2) trains a standing code. (3) is the current pain.
- Informed by: identity harness capturing mailbox; OWASP-style "do not weaken OTP in production."
- Consequences: never attach this mailer when plane is staging/production.

### D-05: Hosted connect callback stays on the hosted origin

- Context: loopback public URL currently yields port 8888, the CLI vault.
- Options: (1) Always `{origin}/connect/callback` in hosted helpers. (2) Listen on 8888 from hosted-dev.
- Decision: (1). Regenerate `src/hosted/client-bundle.ts` after `store-form.ts`.
- Informed by: `http-connect-routes.ts` already serves `/connect/callback` on the hosted process.

### D-06: No new npm dependencies; secrets in `.botpasses-hosted/secrets.json`

- Context: JWK JSON is hostile to `KEY=value` dotenv.
- Options: (1) JSON file + script sets `process.env`. (2) Add `dotenv`. (3) Print exports only.
- Decision: (1). `.gitignore` `.botpasses-hosted/`.
- Informed by: A4; existing `.gitignore` sqlite rules.

### D-07: `dev` is refused when `FLY_APP_NAME` is set

- Context: An operator can set `VAULT_DEPLOY_PLANE=dev` on a Machine to skip Neon. sqlite-hosted on ephemeral disk loses the vault.
- Options: (1) Exit 78 when both are set. (2) Allow and document. (3) Detect Fly via `FLY_ALLOC_ID`.
- Decision: (1). `FLY_APP_NAME` is already the "this process is on Fly" signal for `Fly-Client-IP` and KMS. Self-host on Fly uses staging/production + Postgres.
- Informed by: LiteFS/sqlite-on-volume reject in the grant-vault plan; Fly Machines lose local disk on replace.
- Consequences: laptop `hosted:dev` must not export `FLY_APP_NAME`.

### D-08: `dev` robots and headers follow staging

- Context: `robotsTxt("production")` lists `https://botpasses.com/sitemap.xml`. A laptop hosted process that used production robots would advertise the first-party site.
- Options: (1) Reuse staging robots/noindex for `dev`. (2) New `Disallow: /` robots for `dev`. (3) Skip `/robots.txt` on `dev`.
- Decision: (1). Same function, same noindex. No new crawler policy to maintain.
- Informed by: [`robotsTxt`](../../src/hosted/http-util.ts) 220–238.
- Consequences: widen the plane argument type on `robotsTxt` and `hostedPageHeaders`.

### D-09: Hosted `chooseRedirect` never accepts port 8888

- Context: [`test/providers.test.ts`](../../test/providers.test.ts) 203 and 212 require 8888 when `publicUrl` is loopback. That is the CLI vault callback. Hosted-dev listens on 8788 and already implements `/connect/callback`.
- Options: (1) Change hosted helpers and those tests. (2) Also listen on 8888 from hosted-dev.
- Decision: (1). [`hosted-operator-page.test.ts`](../../test/hosted-operator-page.test.ts) already forbids hosted HTML from advertising 8888.
- Informed by: D-05; `http-connect-routes.ts`.
- Consequences: update `user-oauth.ts` `chooseRedirect`, `connect-redirect.ts`, `store-form.ts`, client bundle, `test/providers.test.ts` lines that expect 8888 for hosted loopback. CLI `assertRedirectUri("http://127.0.0.1:8888/callback")` stays valid.

### D-10: `dev` bind default is loopback in `startHosted`

- Context: [`startHosted`](../../src/hosted/main.ts) uses `VAULT_BIND_HOST ?? "0.0.0.0"`. Fly needs that. A `dev` process without the script inherits it.
- Options: (1) Plane `dev` defaults to `127.0.0.1` when unset. (2) Script-only bind; `startHosted` unchanged. (3) Refuse `dev` unless `VAULT_BIND_HOST` is set.
- Decision: (1). Explicit `0.0.0.0` still works for an operator who wants LAN. (2) fails the first time someone runs `startHosted` from a test or a copied env block.
- Informed by: CWE-1327; RFC 8252 loopback.
- Consequences: extract `bindHostForPlane`. Staging/production default stays `0.0.0.0`.

### D-11: `buildHostedDevEnv` is an allowlist

- Context: Operators export `DATABASE_URL` for `npm run test:pg`. Spreading `process.env` into `dev` would open Neon with a laptop KEK.
- Options: (1) Allowlist; `--postgres` / `VAULT_HOSTED_DEV_DATABASE_URL` to opt in. (2) Inherit `DATABASE_URL` and document the risk. (3) Refuse `dev` if `DATABASE_URL` looks remote.
- Decision: (1). Regex on the URL is a semantic guess. The script never copies `DATABASE_URL`, `VAULT_HOME`, or `FLY_APP_NAME`. `openHostedStore` still honors a URL the operator set on purpose.
- Informed by: Prisma env-file warning; 12-factor attached resources are explicit.
- Consequences: Compose on `dev` is `hosted:dev --postgres` (or set `VAULT_HOSTED_DEV_DATABASE_URL`), not a leftover shell export.

## 7. Technical design

### Architecture / data flow

```text
npm run hosted:dev
  → scripts/hosted-dev.ts
  → ensure secrets.json
  → env VAULT_MODE=hosted VAULT_DEPLOY_PLANE=dev VAULT_PUBLIC_URL=http://127.0.0.1:8788
  → startHosted
       → assertHostedBoot (dev rules)
       → LocalKekProvider(VAULT_KEK)
       → openHostedSqlite(.botpasses-hosted/hosted.sqlite)  [or PostgresStore if DATABASE_URL]
       → createDevMailer() unless RESEND_API_KEY
       → HostedKernel + OperatorIdentity + OAuth AS (issuer = public URL)
       → createHostedServer (secureCookies=false, allowLoopback=true)
       → GET /sign-in  → OTP on stderr
```

Self-host: same `startHosted`, plane `staging` or `production`, `DATABASE_URL` = any Postgres 16, `VAULT_PUBLIC_URL` = `https://vault.example.com`, raw KEK or KMS with `VAULT_KMS_APP_ID`.

### Data model & migrations

None. sqlite-hosted already applies the hosted schema. Postgres migrations unchanged. `scripts/migrate.ts` still uses `DATABASE_URL_DIRECT` then `DATABASE_URL` (any Postgres).

### APIs / tools / jobs / UI surfaces

- New npm script `hosted:dev`.
- New env: `VAULT_HOSTED_SQLITE`, `VAULT_KMS_APP_ID`. `VAULT_DEPLOY_PLANE=dev`.
- `/sign-in`, `/console`, `/mcp`, OAuth discovery on the configured origin.
- Console client bundle regenerate after connect-redirect change.
- Self-host prompt in `site/src/content/docs/self-hosting.md` and `bootstrap-prompts.ts`: capability checklist; `VAULT_DEPLOY_PLANE=staging|production|dev`; Postgres URL; custom origin.

### Failure modes & retries / idempotency

- `hosted-dev --check` is idempotent (reuse secrets.json).
- `hosted-dev --reset` replaces secrets (old sqlite ciphertext will not unwrap; operator deletes the sqlite file or keeps the old secrets). Script prints that warning without printing key material.
- Store open / KMS unwrap failures stay exit 78.

### Feature flags / KV / prompt registry

None.

### Security, privacy, tenancy notes

- `dev` binds 127.0.0.1 by default. Raw KEK + OTP on stderr are laptop-only.
- `dev` dump + secrets.json decrypts items. Threat-model row: local hosted-dev is not dump-resistant. Do not claim otherwise.
- Staging/production origin loosen applies only to non-first-party `https` hosts. Platform-default hostnames stay refused so collect URLs never point at a Fly default hostname.
- Canary isolation tests unchanged (sqlite-hosted already).

## 8. Implementation tasks

### T-01: Deploy plane and origin policy

- Depends on: none
- Touch: `src/brand.ts`, `src/hosted/deploy-plane.ts`, `src/hosted/kernel.ts`, `src/hosted/kernel-items.ts`, `src/hosted/http.ts`, `src/hosted/http-mcp-routes.ts`, `src/hosted/http-util.ts`, `src/hosted/security-headers.ts`, `src/hosted/oauth-as.ts`, `src/hosted/oauth-clients.ts`, `src/hosted/operator-page.ts`, `test/brand.test.ts`, `test/infra-hardening.test.ts`
- Do: Extend `DeployPlane`. `publicOriginError` implements R-05/R-06 and `dev` loopback. `environmentsForDeployPlane` / `defaultEnvironmentForDeployPlane` take `DeployPlane`. Replace `kernel.deployPlane` defaults that treat it as `VaultEnvName` with `defaultEnvironmentForDeployPlane`. Widen `hostedPageHeaders` and `robotsTxt` (R-16). `DEPLOY_PLANE_REQUIRED` names `dev`.
- Acceptance: AC-04, AC-05, AC-10, AC-14.
- Verify: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-reporter=spec test/brand.test.ts test/infra-hardening.test.ts`

### T-02: Boot, store, mailer, cookies, connect redirect

- Depends on: T-01
- Touch: `src/hosted/boot.ts`, `src/hosted/main.ts`, `src/hosted/kms.ts`, `src/hosted/dev-mailer.ts`, `src/cli.ts` (kek-wrap app id), `src/hosted/providers/connect-redirect.ts`, `src/hosted/providers/user-oauth.ts`, `src/hosted/client/store-form.ts`, `scripts/build-client.ts`, `test/providers.test.ts`, `test/hosted.test.ts`
- Do: Dev boot rules (R-01–R-04, R-08, R-09, R-14, R-15, R-20, R-21). `hostedKekBootError` raw-only for `dev`. `hostedBootError` skips the site/dist check on `dev`. `openHostedStore(env)`. `bindHostForPlane`. `startHosted` derives `secureCookies` and omits `siteRoot` when the marketing index is missing. `chooseRedirect` implements R-17. KMS app id R-11. Error text: "Postgres URL" not "Neon pooled." Keep sibling CORS edits in `http.ts` / `http-cors.ts`.
- Acceptance: AC-01, AC-02, AC-03, AC-07, AC-09, AC-11, AC-13, AC-15, AC-17
- Verify: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-reporter=spec test/hosted.test.ts test/hosted-site.test.ts test/providers.test.ts`

### T-03: hosted-dev script

- Depends on: T-02
- Touch: `scripts/hosted-dev.ts`, `package.json`, `.gitignore`
- Do: R-13, R-18, R-22. Extract `buildHostedDevEnv` as an allowlist. `--check` writes secrets and evaluates `hostedBootError` without listen. `--reset` replaces secrets and warns that the old sqlite file will not unwrap. Mode `0o600`. Default bind `127.0.0.1` and public URL port aligned with `PORT`. `--postgres` is the only script path that sets `DATABASE_URL`.
- Acceptance: AC-12, AC-16, AC-18
- Verify: unit-test the secret writer and env builder (extract `buildHostedDevEnv` from the script) in `test/hosted-dev.test.ts`

### T-04: Hosted-dev integration and mailer tests

- Depends on: T-02, T-03
- Touch: `test/hosted-dev.test.ts`, `test/connect-redirect` coverage (extend existing provider tests if present)
- Do: AC-06 (`createDevMailer` + `OperatorIdentity.sendOtp` + event spy). AC-08 (`openHostedStore` + `VAULT_HOSTED_SQLITE` temp path).
- Acceptance: AC-06, AC-08
- Verify: focused `test/hosted-dev.test.ts`

### T-05: Docs, ADR, changelog, site assertions

- Depends on: T-01 (copy must match the policy)
- Touch: `docs/adr/0010-hosted-dev-and-portable-origin.md`, `docs/adr/0002-botpasses-com-origin.md` (status note: amended by 0010), `docs/security/threat-model.md`, `site/src/content/docs/self-hosting.md`, `site/src/content/docs/install.md`, `site/src/content/docs/start.md`, `site/src/lib/bootstrap-prompts.ts`, `site/src/content/docs/prompts.md`, `site/src/content/docs/reference/cli.md`, `README.md`, `AGENTS.md`, `.env.example`, `CHANGELOG.md`, `test/site-content.test.ts`, `test/site-copy.test.ts` if they pin plane names
- Do: Capability vs reference stack. `npm run hosted:dev` in How to run locally. Self-host prompt lists Postgres (any vendor), custom origin, optional KMS app id. AGENTS.md: sqlite-hosted is CLI plus hosted-dev; production hosted is Postgres.
- Acceptance: site-content tests green after `npm run site:build`; changelog Unreleased entry operators would notice
- Verify: `npm run site:build` then `test/site-content.test.ts test/site-copy.test.ts`

## 9. Test plan

- Tests to add or extend:
  - `test/brand.test.ts` — custom origin, `dev` loopback, platform-default refuse, first-party mismatch
  - `test/hosted.test.ts` / `test/infra-hardening.test.ts` — AC-01–AC-03, AC-11 stays
  - `test/hosted-dev.test.ts` — mailer, sqlite path, script `--check`, no KEK in stderr
  - connect-redirect unit (new test or existing providers test)
  - `test/deploy-plane` cases for `dev` env lists
  - site-content / prompts strings
- Regression: AC-11 fails if `VAULT_HOME` refuse is dropped on staging. Brand test fails if `https://example.com` is refused again (old pin) or if `fly.dev` is allowed.
- Gate: `npm run lint && npm test && npm run typecheck` (and `npm run site:build` before site-content).
- Manual: `npm run hosted:dev`, open `/sign-in`, read OTP from the terminal, land in `/console`. Not a substitute for AC-06.

## 10. Rollout & rollback

- Ship: land on shared `dev` when asked to commit. No Fly secret change. Staging/prod tomls already set first-party `VAULT_PUBLIC_URL`.
- Rollback: revert the commit. Existing Neon data and KMS wraps unchanged. Laptop `.botpasses-hosted/` is local and unused after revert.
- Monitoring: first-party planes keep `hosted_listening` with `plane=staging|production`. A `plane=dev` line on Fly means a Machine was mis-set; that is a config error, not a metric to add.

## 11a. Pre-mortem (review-plan)

- **Six months later: staging Machine has `VAULT_DEPLOY_PLANE=dev`.** Someone "simplified" Fly to skip Neon. Disk is empty after a deploy. Mitigation: R-15. Kill signal: `hosted_listening` with `plane=dev` on Fly.
- **Six months later: laptop `/robots.txt` cites botpasses.com.** Crawlers or confused operators treat the laptop as first-party. Mitigation: D-08 / AC-14.
- **Six months later: Spotify connect from hosted-dev redirects to :8888.** Nothing listens. Mitigation: D-09 / AC-15. `test/providers.test.ts` must flip with the code.
- **Six months later: OTP digits sit in Sentry via `logVaultEvent`.** An engineer reused the `dev` mailer helper on staging. Mitigation: R-09 and R-19; mailer installed only when plane is `dev`.
- **Six months later: two agents smash `test/site-content.test.ts`.** Mitigation: A7. Stop and ask.
- **Six months later: `dev` listens on Wi-Fi.** Someone ran `startHosted` with `dev` env and no bind. OTP and session cookies are on the LAN. Mitigation: D-10 / AC-17.
- **Six months later: laptop `dev` wrote to Neon.** A leftover `DATABASE_URL` from `test:pg` was inherited. Mitigation: D-11 / AC-18.

Serious alternative not chosen: skip the origin unlock and ship only `hosted:dev` + sqlite. That leaves self-host docs false (`brand.ts` still pins botpasses.com). The user asked both jobs.

## 11. Risk register

- Staging/prod accidentally sqlite: mitigated by R-02 (no sqlite branch unless plane is `dev`).
- Custom origin on our Fly secret: operator must change `VAULT_PUBLIC_URL`; tomls encode first-party. Collect URLs would follow the secret. Same class of mistake as pointing DNS wrong.
- sqlite/prod behavior drift: `test/store-parity.test.ts` and `npm run test:pg` stay. Hosted-dev is not a substitute for Postgres CI.
- Cookie `Secure` on HTTP: R-07 / AC-07.
- Connect 8888 dead-end: D-05 / AC-09.
- OTP in terminal scrollback on a shared laptop: documented; bind loopback. Structured logs stay code-free (R-19).
- `dev` on Fly: R-15 / AC-13.
- Production robots on a laptop: D-08 / AC-14.
- Hosted connect still targeting 8888: D-09 / AC-15.
- `dev` on all interfaces: D-10 / AC-17.
- Inherited Neon URL: D-11 / AC-18.

## 12. Definition of done

- [ ] All ACs pass
- [ ] `npm run lint && npm test && npm run typecheck` green (show output)
- [ ] Docs, changelog, ADR 0010, AGENTS.md, `.env.example`, site prompts in the same change
- [ ] Client bundle regenerated if connect-redirect / store-form changed
- [ ] No stubs or in-scope work left unbuilt
- [ ] External research recorded and reflected in D-01–D-11
- [ ] plan-ban-sweep RECEIPT quoted; `plan-checker` PASS
