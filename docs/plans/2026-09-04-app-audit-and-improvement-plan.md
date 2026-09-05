# Botpasses: full audit and top-to-bottom improvement plan

Date: 2026-09-04. Branch audited: `origin/dev` at `939486f` (the product; `main` is a two-line README).

## How this was produced

Five independent deep reads, each over whole files, plus the running app and the built site:

| Area | Method |
| --- | --- |
| HTTP, identity, OAuth AS, KEK | Read every file in `src/hosted/` touching auth, plus `oidc-provider` 9.12 internals where a finding depended on them |
| Vault core, MCP, connector, stores | Read `src/*.ts`, `src/hosted/{mcp,mcp-http,need-ops,connector,spotify,agentpass}.ts`, both stores, all migrations and tests |
| Operator console | Booted the hosted server on SQLite with a captured OTP mailbox, drove it with Playwright at 1280 and 390 px, ran axe on 13 states, 39 screenshots |
| Marketing site and docs | Built `site/`, served `dist` through the real static handler, probed headers and routing, 21 screenshots |
| Infra, CI, DB, deps, tests | Ran `npm ci`, `npm audit`, `tsc`, the full suite with and without Postgres 16, coverage, site build; read every workflow, toml, and migration |

Every finding below was checked against source. Headline findings were re-verified by hand before ranking.

Gate results on this branch: `npm ci` 0 vulnerabilities; `tsc --noEmit` clean; `npm test` 245 tests, 243 pass, 2 skipped without `DATABASE_URL`, 245/245 with Postgres; coverage 84% lines, 78% branches; site builds 21 pages in 2.3 s.

---

## 1. What is built, and what it is trying to be

**The promise.** An operator stores a named credential once. An AI agent (Claude, Cursor, ChatGPT, Grok) connects over MCP and calls `http.request`. Botpasses finds the credential, asks the operator to approve if needed, makes the outbound HTTPS call with the credential attached, and returns a redacted body. The model never sees the value. Not a password manager. Not zero-knowledge. A "grant vault" that decrypts only at approved inject.

**What exists (hosted plane).**

- First-party operator identity: email OTP, TOTP with backup codes, opaque HttpOnly sessions, signed double-submit CSRF. No third-party IdP.
- Same-origin OAuth 2.1 authorization server on `oidc-provider` 9.12: PKCE S256, RFC 8414/9728 discovery, dynamic client registration, device flow, RS256 access JWTs bound to `${origin}/mcp` with a `jti` denylist, refresh rotation, RFC 7009 revoke.
- Machine bearers: `avm_` (model channel, MCP) and `avt_` (trusted runtime, may call `POST /runtime/resolve` for plaintext).
- Data model: org, members, one vault, two environments (staging, production), folders, items (`secret`, `login`, `client_secret`), clients pinned to one environment, grants with four policies (`prompt`, `session` 8 h, `item_standing`, `folder_standing`), needs (a "collect this key" request with a path-only `collect_url`), approval challenges (8-digit code and HMAC magic link), audit, access-events ledger.
- Crypto: KMS-wrapped platform KEK via Fly OIDC, per-org DEK, AES-256-GCM items with AAD `orgId`. Local CLI uses a master key with name-bound AAD.
- MCP: five tools (`list_items`, `find_items`, `request_grant`, `list_grants`, `http.request`), stateless JSON-RPC 2024-11-05, steering via `initialize.instructions` and a `next.for_model` field on every result.
- Connector: exact host allowlist, method allowlist, DNS resolve then connect to the pinned IP with SNI, no redirects, 10 s timeout, 256 KiB cap, substring redaction, Spotify client-credentials mint and refresh-token user connect.
- Console: single page with three panels (Inbox, Vault, Access), five dialogs, server-rendered HTML with hand-written JS.
- Marketing site: Astro, 21 pages, Fraunces + IBM Plex, dark only, Pagefind built but not wired.
- Infra: two Fly apps (one machine each), Neon Postgres per plane, Cloudflare in front, GitHub Actions CI, staging auto-deploy from `dev`, prod by manual dispatch, nightly encrypted `pg_dump` to R2.
- Local plane: SQLite vault, `vault run` env injection, loopback console, stdio MCP with three tools and no inject tool.

**Where it stands.** Staging is live at `staging.botpasses.com`. Production DNS resolves but has no machines. Three PRs landed in the last four days. The trust model and threat-model documents are unusually honest. The core invariant (no secret value reaches the model) holds: canary tests cover MCP results, REST, inbox, email, audit, collect HTML, and the SQLite file, and no reviewer found a direct value leak. The product is real and the architecture is sound. What is not yet true is that it is safe to open to strangers, that the console is finished, or that the site sells it.

---

## 2. Verdict

Botpasses is a strong prototype with a correct core and a long tail of unfinished edges. The single most important fact: **the two things the security story rests on, TOTP and tenant isolation for OAuth clients, are both broken today.** Fix those, unblock production backups, and the product is defensible. Then the work is finishing the console, making the site say what the README already says, and removing Spotify from the generic layer so the second integration is cheap.

Ten things that matter most, in order:

1. TOTP is enrolled but not enforced at sign-in. Email OTP alone yields a full owner session for any user who has ever enrolled. Anyone can also re-enroll TOTP without the old factor.
2. OAuth-connected agents can cross tenants. Hosted MCP hosts register one dynamic client per server URL and reuse it for every user; Botpasses maps the JWT to `clients` by that shared id with no org filter and ignores `sub`.
3. Production has no offsite backup running. GitHub's default branch is the empty `main`, so the backup cron, Dependabot, and the prod deploy dispatch are all inert.
4. OAuth-connected agents are hard-pinned to the `staging` vault environment at token issue, so Claude, Cursor, and ChatGPT can never reach production items even on the production plane. Only hand-issued `avm_` tokens can.
5. A model client can email an approval link to any address via the REST grant route, and that link approves on a GET with a Lax cookie.
6. Standing grants are duplicated on every request and revoke touches one row, so "immediate revoke" is not true. `http.request` also bypasses the grant rate limiter.
7. Basic-auth and URL-encoded forms of a secret are not redacted from upstream bodies; only the raw string and the last four characters are.
8. The console has broken basics: every dialog's Cancel button is blocked by the app's own CSP, the vault table breaks at desktop width, backup codes are never shown, there is no sign-out, Back does not work.
9. The homepage is a heading and three buttons. The security page omits the trust model, encryption, connector hardening, and the canary tests that are the actual differentiators. Canonical URLs point at 404s. Hashed assets are served `no-cache`.
10. Spotify is hard-coded in eleven source files. The generic `http.request` path is 60 percent Spotify. There is no provider abstraction, so GitHub Apps, Google, Stripe Connect, or any OAuth client-credentials API needs more special cases.

Also structural: 387 of 586 tracked files are agent-harness scaffolding. `INSTALL.md` and `docs/usage.md` are about a different project. Two ADRs are numbered 0003 and two 0004. Three version numbers disagree.

---

## 3. Findings

Severity: **P0** exploitable or product-breaking now. **P1** real defect, fix this month. **P2** quality, hygiene, or polish.

### 3.1 Security

| ID | Sev | Finding | Where | Fix |
| --- | --- | --- | --- | --- |
| S1 | P0 | MFA not enforced at sign-in. `ready` is derived from whether the user row has TOTP, not whether this session passed TOTP. Sign-in script sends enrolled users straight to `/console` after the email code. Re-enroll (`totp/start`, `totp/confirm`) needs no current factor; old backup codes survive; the pre-MFA session is never deleted. | `src/hosted/identity.ts:42`, `operator-identity.ts:238-342`, `hosted-assets.ts:95` | Add `mfa_at` to `operator_sessions`. OTP verify issues a pending session; `requireOperator` treats it as not ready. Add `POST /api/auth/totp/verify` at sign-in; route enrolled users there. Require a current code before re-enroll; invalidate unused backup codes on re-enroll; delete the pending session on upgrade. Test: enroll, log out, OTP verify, `GET /api/items` is 403 `mfa_required`. |
| S2 | P0 | Cross-tenant OAuth. JWT to client lookup is `WHERE oauth_client_id = $1 LIMIT 1` with no org filter and `sub` unused; token-issue hook creates one client per org with the same DCR id. Revoking in org A also destroys B's oidc payloads. | `identity.ts:99-101`, `store/postgres.ts:393-399`, `oauth-as.ts:268-282` | Resolve `sub` to the org first, then `(org_id, oauth_client_id)`. Unique index on that pair. Scope `destroyOidcPayloadsForClient` by account. Two-org test with one DCR client id. |
| S3 | P0 | Model channel can trigger approval email to an arbitrary address; `GET /approve?token=` approves on GET with a `SameSite=Lax` session. | `http.ts:685`, `kernel.ts:630-639`, `http.ts:752` | Drop `operator_email` from the model channel (derive from members). `/approve` GET renders a confirm page; approve on POST with CSRF. Escape `client.name` in email HTML (it comes from DCR `client_name`). |
| S4 | P0 | Cookie-authenticated `POST /mcp` has no CSRF check, accepts any Origin, and mints a synthetic model client with the environment taken from the body. | `http.ts:105,332-378,856-869` | Require `X-CSRF-Token` for cookie principals on `/mcp`, or reject cookie principals there. Enforce Origin for cookie MCP. |
| S5 | P1 | Consent phishing. Open DCR accepts any `https://` and, via the regex, any private-use scheme; consent page shows the raw `dcr_…` id, not the client name; `/device` shows no client. Spotify user connect then grants `item_standing` to every model client in the org, including one registered by an attacker. | `oauth-as.ts:57-76`, `oauth-interactions.ts:37-38`, `kernel.ts:1112-1128` | Look up the client and show `client_name` + redirect host on consent and device. Tighten the scheme allowlist to the named list. Scope the Spotify auto-policy to the requesting client or require a normal approval. |
| S6 | P1 | Duplicated standing grants. `requestGrant` always inserts; with a policy each call yields a new `active` grant with no expiry; `revokeGrant` revokes one row; `consumeActiveGrant` finds another. `http.request` calls `requestGrant` without the limiter. | `kernel.ts:556-601,767,1146`, `mcp-http.ts:394`, `http.ts:359` | Return the existing open grant for `(client,item)`. Revoke all active grants for the pair. Move the limiter into `kernel.requestGrant`. |
| S7 | P1 | Redaction gaps. Only raw secret and last-4 are stripped; `base64(user:secret)`, `encodeURIComponent(secret)`, JSON-escaped forms pass through an echoing origin. `redactOauthJson` only rewrites top-level keys. Truncation to 256 KiB happens before redaction. Last-4 masking rewrites every 4-char match in the body and mangles dates and ids. | `connector.ts:107-114,175`, `redact.ts:21` | Build a redaction set with all encodings. Walk JSON recursively. Redact before truncating. Drop body-wide last-4 masking. Test with a Basic-auth item against an echo origin. |
| S8 | P1 | Per-IP limiters trust the first `X-Forwarded-For` hop and grow unbounded; `totp/confirm` has no attempt counter and falls through to up to 10 scrypt backup-code checks per attempt. | `operator-identity.ts:190-193,325-342`, `oauth-as.ts:331-336` | Read `Fly-Client-IP`; cap the limiter map; DB-backed TOTP failure counter with lockout. |
| S9 | P1 | KEK rotation orphans TOTP secrets. TOTP secrets and sealed Spotify state are wrapped under the KEK directly; `rotateKek` re-wraps org DEKs only. After rotation every TOTP confirm fails. | `operator-identity.ts:305,326`, `kernel.ts:220-250,1032` | Wrap identity secrets under a dedicated identity DEK or the org DEK; extend `rotateKek`; test rotate then TOTP verify. |
| S10 | P1 | `oidc-provider` is not told it is behind a TLS-terminating proxy while `cookies.secure` is true. Koa's `ctx.secure` will be false on Fly; the cookie library throws on `/oauth/authorize` and `/device`. Tests run with `secureCookies:false`. Not verified against the live deploy. | `oauth-as.ts:85-89`, `main.ts:62` | Set `provider.proxy = true` when hosted; test with `secureCookies:true` and `x-forwarded-proto: https`. If browser OAuth works today, find out what is compensating. |
| S11 | P1 | Hosted item envelopes are bound only to `orgId`. DB write access can swap ciphertexts between items or edit plaintext `allowed_hosts_json`/`inject` on a high-value item. Local already fixed the analogue. | `kernel.ts:312,361,993` | AAD `orgId|itemId|allowedHostsJson|inject`; re-encrypt on meta change (`updateItem` already re-encrypts on shape change). |
| S12 | P1 | `oidc-provider`'s own 14-day session outlives Botpasses logout; later authorize requests skip our consent and readiness check. `/device` POST always fails xsrf (hidden field omitted). Consent `decision` defaults to allow. | `oauth-as.ts:207`, `auth-pages.ts:84-87`, `oauth-interactions.ts:56-58` | Short `ttl.Session`, end the OP session on logout, render the xsrf field, require `decision === "allow"`. |
| S13 | P2 | Raw error messages (pg constraint names, `Key (email)=(…)`) go to clients as 400 and to Sentry; malformed JSON bodies leak their first bytes via Node's `SyntaxError` message. | `http.ts:944-973`, `observe.ts:14` | Generic 500 with request id; catch `SyntaxError` in `readJson`; capture only unknown errors. |
| S14 | P2 | `audit.inject` is written before the request leaves the process, so a `host_mismatch` still shows as "fetched" in Access. | `kernel.ts:892` | Audit after send; record `inject_denied`/`inject_failed`. |
| S15 | P2 | `revokeSession` matches by `startsWith` on a 1+ char URL prefix; `listOperatorSessions` is org-wide so any member can revoke the owner. `deleteOrg` leaves `access_events`, `rate_hits`, `oidc_payloads`. `ensureModelClient` reuses revoked clients. `OrgRateLimiter` is check-then-increment. | `kernel.ts:1407`, `postgres.ts:105-145,963`, `kernel.ts:531`, `rate-limit.ts:24-30` | Exact match on full hash; owner-only for others' sessions; complete the cascade; filter `revokedAt`; use `RETURNING count`. |
| S16 | P2 | Unauthenticated `GET /mcp` SSE holds connections forever; `server.close()` waits for them, so SIGTERM never completes and Fly SIGKILLs. | `http.ts:246-257`, `main.ts:90-101` | Require auth, cap per principal, `closeAllConnections()` with a deadline. |
| S17 | P2 | Legacy local console concatenates API data into `innerHTML` (loopback-only stored XSS). `isBlockedIp` misses multicast, reserved, TEST-NET, NAT64, 6to4 ranges. Same secret keys CSRF HMAC and OP cookies. `http://localhost` accepted for redirects. No `Vary: Origin`. | `src/operator-page.ts:137-148`, `ssrf.ts:32-57` | Escape or retire the local console; extend the blocklist; HKDF per-purpose keys; loopback IP only. |
| S18 | P2 | AgentPass (dark): `authorization-check` returns `allowed: true` for `pending`; JWKS published but nothing is signed; keys regenerate per boot with a fixed `kid`; `holder_cnf` compared with `!==`. | `agentpass.ts:88-104` | Do not enable until rewritten. |

Not found after looking: SQL injection (all parameterized), redirect following, DNS rebinding, GCM nonce reuse, timing on hashed tokens, model reaching production items on the staging plane, cross-org id use on grants/needs/clients (all 404), committed secrets.

### 3.2 Product-breaking defects (not security)

| ID | Sev | Finding | Where |
| --- | --- | --- | --- |
| D1 | P0 | OAuth-issued clients are created with `environment: "staging"` and there is no way to change a client's environment. On the production plane, Claude/Cursor/ChatGPT can never see production items. The tool schemas still advertise `environment: production`. | `oauth-as.ts:280`, `hosted/mcp.ts:172-174` |
| D2 | P0 | Every dialog Cancel is `onclick="…"` under a nonce CSP with no `unsafe-hashes`. Chrome refuses it. Pointer users cannot cancel Store, Rotate, Delete, Spotify, or Confirm. | `operator-page.ts:177,191,204,213`, `security-headers.ts:45-57` |
| D3 | P0 | Backup codes are written to `#backups` and the next line redirects to `/console`. Nobody has ever seen their backup codes. | `hosted-assets.ts:136-138` |
| D4 | P0 | Vault table breaks at 1280 px: `display:flex` on a `<td>` removes it from table layout, rows go to ~170 px tall, Last-4 and Actions are pushed off-screen. | `console-css.ts:279`, `console-js.ts:146` |
| D5 | P0 | Email approval notifications never fire for agent-originated grants. Only the REST route passes `operatorEmail`; MCP `request_grant` and `http.request` never do, so `notify_failed` is written on every agent request and the README's "approve via magic link" is only true for a manual REST call. | `kernel.ts:563,630`, `hosted/mcp.ts:241`, `mcp-http.ts:394` |
| D6 | P1 | No sign-out anywhere in the UI. `POST /api/auth/logout` exists. | `http-auth-routes.ts:115` |
| D7 | P1 | Hash navigation is write-only (`replaceState`, no `hashchange`/`popstate`). Back never works; deep links do nothing. | `console-js.ts:74` |
| D8 | P1 | One generic confirm dialog ("Confirm this change.") for delete item, revoke client, rotate token, revoke grant, revoke session. Rotate silently invalidates the live token. | `operator-page.ts:208-215`, `console-js.ts:43-49` |
| D9 | P1 | Pre-TOTP session lingers and shows as a revocable orphan in Sessions. `HEAD /console` is 404. `favicon.svg` is served from the marketing root, so the console rail shows a broken image if `siteRoot` lacks it. | `operator-identity.ts:275,322`, `http.ts:295`, `static-site.ts:27` |
| D10 | P1 | Site canonical URLs on 20 of 21 pages end in `.html` and the server 404s them; `/sitemap.xml` is listed but never emitted; robots has no `Sitemap:`; hashed `_astro/*` assets and the favicon are `cache-control: no-cache` because the `hashed` branch is unreachable. | `site/src/layouts/Base.astro:15`, `static-site.ts:30,62-77` |
| D11 | P1 | Docs search input has no script. Pagefind (772 KB) is built, served, and CSP-allowed but never loaded. | `site/src/layouts/Docs.astro:18-21` |
| D12 | P1 | MCP tool name `http.request` contains a dot; Anthropic and OpenAI function-name grammars are `^[a-zA-Z0-9_-]{1,64}$`. Some hosts sanitize or reject it, and every `next.tool: "http.request"` then names a tool the model never saw. | `hosted/mcp.ts:32`, `mcp-steer.ts` |
| D13 | P1 | Store dialog defaults Environment to `staging` even on the production plane, so the first secret lands where a production-bound agent cannot see it. | `operator-page.ts:156` |
| D14 | P2 | `approveByCode` increments `attempts` on every pending challenge for each wrong code, so five typos lock out every pending approval in the org. | `kernel.ts:718-753` |
| D15 | P2 | Hosted `session` grants are never marked `expired`; `list_grants` shows `active` with a past `expires_at`. Local MCP miss message says `vault store`; the command is `vault set`. | `kernel.ts`, `src/mcp.ts:151` |
| D16 | P2 | `pendingTotp`, OTP IP limiter, DCR limiter, CIMD cache, Spotify mint cache are all in process memory. A restart or a second machine mid-enrollment yields "TOTP enrollment not started". Nothing says "do not scale". | `operator-identity.ts:154-180`, `fly.*.toml` |

### 3.3 Infrastructure, CI, data

| ID | Sev | Finding | Where |
| --- | --- | --- | --- |
| I1 | P0 | GitHub default branch is `main`, which contains only `README.md`. Scheduled workflows and Dependabot read from the default branch, and `workflow_dispatch` is only listed for it. Result: **no nightly backups are running**, Dependabot is inert, prod deploy is not in the Actions UI. `restore.md:5` and `README.md:190` say to fix this; it was not done. | GitHub settings |
| I2 | P0 | Neither `fly.*.toml` declares `[[http_service.checks]]`, so `/health` and `/ready` are never probed. No `kill_timeout`; default 5 s vs a drain that waits on SSE. | `fly.staging.toml`, `fly.prod.toml` |
| I3 | P0 | No index on `clients.hashed_secret`, which is looked up on every bearer-authenticated request. Also missing: `operator_sessions(user_id)`, `email_otp_challenges(email)`, `approval_challenges(grant_id)`, `backup_codes(user_id)`, `need_items(org_id,status)`, `grants(client_id,item_id,status)`. | `store/schema.ts` |
| I4 | P0 | Prod deploy accepts any free-text SHA, has no `environment:` with required reviewers, does not verify the SHA is on `dev` or was deployed to staging, and runs without `npm audit` or the Postgres service (so the two PG tests silently skip on the prod gate). | `.github/workflows/deploy-prod.yml` |
| I5 | P1 | `migrations/*.sql` is dead. Nothing reads it; `PostgresStore.migrate()` runs string constants from `schema.ts` on every boot through the pooled URL, with no `schema_migrations` table, no advisory lock, no version. Drift already exists (`rate_hits` in no SQL file; two indexes in SQL that `schema.ts` lacks). `001_init.sql:1` says "Applied by PostgresStore.migrate()", which is false. `DATABASE_URL_DIRECT` is documented for migrations and never used by the app. | `migrations/`, `store/postgres.ts:39-47`, `main.ts:35` |
| I6 | P1 | `PostgresStore`, the production store, has 41% line and 29% function coverage even with Postgres present. Every behaviour test runs against `SqliteHostedStore` (94%). `fetchPinned`, the production network path, is never executed by any test. | `test/*`, `connector.ts:186` |
| I7 | P1 | No foreign keys on 16 tables; no CHECK constraints on enum columns; TEXT timestamps; no expiry sweeps for OTP challenges, sessions, oidc payloads, approval challenges, access events, needs, rate hits. `oidc-adapter.consume()` re-upserts without TTL so consumed codes never expire; `findByUid`/`findByUserCode` full-scan and `JSON.parse` every row of a kind. | `schema.ts`, `oidc-adapter.ts:100-124` |
| I8 | P1 | Pool has no `connectionTimeoutMillis`, `statement_timeout`, `idleTimeoutMillis`, or `application_name`. Resend and Sentry fetches have no timeout. `PostgresStore.open` failure at boot is an unhandled rejection, not exit 78. Second SIGTERM double-closes. `void startHosted()` has no `.catch`. | `postgres.ts:37`, `main.ts:35,90-106` |
| I9 | P1 | Supply chain: `superfly/flyctl-actions/setup-flyctl@master` (moving branch, with `FLY_API_TOKEN` in scope); no `permissions:` in any workflow; backup job `npm install --no-save aws4fetch` unpinned at run time on the runner holding DB and R2 creds; `.mcp.json` runs two `@latest` executables at every agent session; Dockerfile `node:22-bookworm-slim` unpinned; Dependabot lacks `github-actions` and `docker` ecosystems. `pg_dump` client is whatever apt ships; a Neon PG17 project would fail with version mismatch, never exercised. | workflows, `.mcp.json`, `Dockerfile` |
| I10 | P1 | No linter exists (the `no-any`, `no-floating-promises` rules in `CLAUDE.md` are prose). No coverage gate. No secret scanning, SAST, SBOM, or Docker build check in CI. `deploy-staging.yml` re-runs the whole suite instead of `workflow_run`. | `.github/workflows/ci.yml` |
| I11 | P1 | Sentry uses the legacy `/api/<project>/store/` endpoint with raw `fetch` and no auth header; failures are swallowed. No request log, request id, latency, or auth-event logging (OTP/TOTP failures). Nothing alerts on `kek_raw_fallback` or backup failure. | `observe.ts` |
| I12 | P2 | `npm test` on a fresh clone fails until `site/` is built; neither README nor AGENTS.md says so. `.dockerignore` `node_modules` does not match `site/node_modules`, so deploy jobs ship ~200 MB of context. `migrations/` is copied into the image and never read. Env vars `FLY_APP_NAME`, `VAULT_BIND_HOST`, `VAULT_PORT`, `VAULT_SITE_ROOT` are used and undocumented. `package.json` 0.4.0, CHANGELOG 0.4.1 + Unreleased, MCP `serverInfo.version` 0.3.4. | `package.json`, `.dockerignore`, `.env.example` |

### 3.4 Console UX and design

Verified in the running app (screenshots in the reviewer output; key ones re-checked by hand).

**Journeys.**

- Sign-up and sign-in are the same flow with two entry points. After "Send code" the first form stays visible: two Email fields, "Send code" and "Verify" at once. No resend, no countdown, no attempts-remaining hint. "Then TOTP if you have not enrolled yet" reads as a typo and is jargon.
- Enroll shows the raw `otpauth://` URL with the secret in a large `<pre>` in addition to the grouped key. Backup codes never appear (D3); no "I saved these" step; no way to view, reset, or re-enroll later.
- Store: Environment defaults to staging (D13); "Allowed hosts (comma)" is required with no explanation of why; placeholder and permanent hint are Spotify-specific; name validation is server-side only and the error is regex-speak. Cancel is dead (D2). The success flash never clears.
- Connect an agent: everything says Grok. Button "Issue Grok Bot token", default name `grok`, a 70-word banner mixing four topics as the first thing on Access. The issued token appears in a `<pre>` below the form with a small Copy button; on mobile you have to notice it.
- Inbox is the best screen: clear card titles ("cursor wants STRIPE_SECRET_KEY"), task description, one primary action, correct post-approve state. Missing: timestamps, code expiry countdown, a Deny action, any refresh (no polling or SSE).
- Access is one ~2000 px column: banner, issue form, Clients, Grants, Sessions, Audit. Audit rows are raw enums (`request_grant`, `notify_failed`, `session_created`, `token_issued` with no client name). Sessions are hash prefixes with no device or IP.
- Missing everywhere: search, filter, sort, paging (audit capped at 200), item detail (created, rotated, last used, by whom), per-item revoke, bulk actions, loading states, disabled-while-submitting, network-error handling (offline console shows nothing), copy for item name and client id, team/org, account settings.

**Visual.** Fraunces + IBM Plex is a distinctive, credible pairing for a security tool. One green does everything (primary, link, focus, active nav, success, badge), so action and success are indistinguishable and there is no warning colour for pending or once-shown states. Card titles are 1 rem Plex 600, so hierarchy inside the workspace is flat. Dark only with `color-scheme: dark` hard-coded. The mark is used only as a 28 px favicon-as-logo. "Environment plane production" in the rail is an infra concept leaking into the UI. The marketing site and the console are two visual systems: square buttons and no radius on the site, 8 to 10 px radius, cards, and a radial gradient in the console; tokens hand-copied into three places.

**Accessibility.** Good bones: landmarks, skip link, `role=status` flash, native `<dialog>`, 44 px targets, visible focus, reduced-motion, contrast-tested tokens, local QR with `role=img`. Gaps: dialogs have no accessible name; error boxes have no `role=alert`; mobile table transform strips table semantics; `th` lack `scope`; the auth brand link sits outside any landmark (axe `region`); hidden fields are `<label hidden>` not `type=hidden`; the once-shown token has no live region; docs link targets are 20 to 22 px (WCAG 2.2 says 24).

**Front-end code.** All interpolations in hosted templates are escaped or constant (checked one by one); client JS uses `textContent`/`createElement` throughout. But: the nonce guards nothing (no inline scripts remain, and the inline handlers it would have covered are the dead Cancel buttons); `csrf()`, `headers()`, flash helpers are copy-pasted across three JS strings; store-form logic exists three times (server, console JS, collect JS) and tests assert the duplicates match by regex; the 560-line console JS is an untyped string with regex tests over its source; `src/operator-page.ts` is a second, diverged console for the local CLI with unescaped `innerHTML`.

**Copy.** Em-dashes in five places despite the repo rule. Jargon: TOTP, otpauth, break-glass, bootstrap token, origin 4xx, OAuth connect card, desktop app scheme, client_credentials, Last-4. Product-specific copy in generic UI: Spotify in the inbox empty state, store hint, placeholder, kind auto-fill, and Access hint; Grok in the button, banner, default name, and errors. Four words for one thing: credential, item, secret, key. "Vault" means the nav panel and the org. The retry edge case ("does not need a new 8-digit code") is repeated in five places.

### 3.5 Marketing site and docs

- Homepage: H1, one paragraph, three buttons, 55 percent of the viewport empty. No how-it-works, no code, no diagram, no "works with", no comparison, no FAQ, no pricing or beta line, no GitHub link, no support or security contact. The README's threat table, encryption paragraph, connector hardening, and canary tests are all absent from the public site.
- Security page says "Values are injected into tool or runtime env only", which is wrong for the hosted connector path (the value goes into an outbound header). The honest "grant-vault, not zero-knowledge" line from the README and ADR 0003 never appears publicly.
- Docs: labelled Diátaxis but with a fifth "Connect" section that duplicates How-to; Claude, OpenAI, and Cursor connect pages are one sentence each; only Grok is substantive and it is Spotify-heavy. Missing: troubleshooting, FAQ, install, self-hosting, rate limits, security disclosure. Drift: `request_grant` accepts `task_id`, docs omit it; `find_items` returns `kind` and `environment`, docs omit them; seven live routes are undocumented publicly; the site changelog has one entry while the repo has 0.4.1 and fifteen Unreleased bullets.
- Model-facing copy from `prompts/mcp-hosted.ts` is pasted into the human MCP reference ("Do not ask for a token").
- "this origin" appears 14 times on a site whose origin is botpasses.com.
- SEO: canonical broken (D10); 19 pages share one meta description; no `og:url`, `og:site_name`, `twitter:*`; `og.png` is a blank dark rectangle; no `BreadcrumbList`; no `llms.txt` or `security.txt`; no HTML 404 (JSON error body).
- Mobile: tables overflow at 390 px with no `overflow-x` wrapper; `h3` unstyled so reference subheads look like body text; docs search is unstyled browser default.
- Performance: 11.7 KB render-blocking stylesheet that could be inlined (CSP already allows it); no preload for Fraunces 700 so the H1 flashes from Georgia; two font pipelines (fontsource on the site, hand-served woff2 in the console).

### 3.6 Code quality and repository

- Two products in one repo. `src/{vault,db,mcp,server,operator-page}.ts` (local) and `src/hosted/*` (hosted) have separate tool names (`list_secrets` vs `list_items`, `secret_name` vs `item_name`, `scope` vs `policy`), separate consoles, separate JSON-RPC handlers, and local has no inject tool over MCP. A builder targeting both writes two integrations.
- Spotify in the generic layer: `injectHeaders` hard-codes `accounts.spotify.com`; `mcp-http.ts` is majority Spotify; `spotify.ts` is 350 lines; 131 occurrences across 11 files. No abstraction for "OAuth2 client-credentials provider" or "refresh-token provider".
- Duplication: two `publicGrant`, four `optional()`, three `nowIso`, two redactors, two `FORBIDDEN` lists, two `NeedItem` payload types, `headerBag` twice, two `res.writeHead` monkey-patches that stack, byte-identical `POST /api/items/:id/meta` and `POST /api/items/:id` handlers, `rotateItem` duplicating half of `updateItem`, both stores ~1200 lines of near-duplicate mappers.
- Dead code: `cimd-fetch.ts` (CIMD promised in ADR 0004, never wired), `assertDcrRequest`, `oauthCallback`, `hashBearer`, `lookupTrusted`, `updateItemMeta`, `assertNoSecret`, `dirnameOf`, `#access-revoke` dialog (pinned by a test), `--*-oklch` CSS vars, unreachable `/consent` and `/device` branches in `tryAuthPage`.
- Stringly-typed control flow: `err.message === "inject_denied"` as a discriminator; `isPreparedConnector` duck-types on `typeof rec.secret`; `status` is a number for origin results and a string for vault states and both branch on `typeof`.
- Hand-written `oidc-provider.d.ts` is required (the package ships no `.d.ts` and there is no `@types` package) but erased configuration typing (`config?: Record<string, unknown>`); it should declare the options Botpasses uses, not widen to unknown.
- Giant files: `kernel.ts` 1470, `sqlite-hosted.ts` 1287, `postgres.ts` 1243, `http.ts` 1023 (one `api()` with ~30 inline routes).
- `cli.ts` imports `pg`, the AWS SDK, and the hosted kernel for every local command.
- Repository: 387 of 586 tracked files are `.cursor/`, `.loadout/`, `.claude/`, `processes/`, and loadout docs. `INSTALL.md`, `docs/usage.md`, `docs/catalog.md`, `docs/agentic-patterns.md`, `docs/external-practices.md`, `docs/agent-harness-engineering.md`, `docs/loop-engineering.md`, `docs/loadout/` are about the loadout project, not Botpasses. `CLAUDE.md` is 938 lines, 912 of them projected rules, under a header that says to keep it short. `docs/plans/` and `.cursor/plans/` overlap with two diverged copies and five hashed Cursor variants. ADRs `0003` and `0004` each exist twice.
- Tests that grep source or YAML for wording (`trust-copy`, `backup-envelope`, `brand`, `access-ledger:189`) will fail on harmless prose edits and pass when behaviour is wrong.

---

## 4. Strategic gaps

These are not bugs. They are places where the current shape will not carry the product to its second customer.

**4.1 The grant is too coarse.** A grant is `(client, item)`. A grant for "read Stripe balances" is a grant for `DELETE /v1/customers/*`. There are no per-grant host, path, or method constraints, no call quotas, no TTL on `item_standing`, and hosted `session` is a fixed 8 hours. `request_grant` should take the `host`, `method`, and `path` it will be used for, and a policy should be able to say "GET only", "these path prefixes", "N calls", "until date". This is also what makes the inbox card meaningful: "cursor wants to GET api.stripe.com/v1/balance" is approvable; "cursor wants STRIPE_SECRET_KEY" is a blank cheque.

**4.2 Providers, not special cases.** Spotify's three behaviours (client-credentials mint on a token host with Basic and form body, refresh-token user connect with PKCE, "this path needs a user token" hints) are generic OAuth2 behaviours. Define a provider record: token host, auth style at the token endpoint, grant types, scopes, redirect rules, redaction keys, user-path hints. Store it as data, ship Spotify, GitHub App, Google, Slack, Stripe Connect as entries, and let operators add one from the console. Then `mcp-http.ts` becomes generic, and the prompt stops being a Spotify FAQ.

**4.3 Auth schemes beyond Bearer and Basic.** Today: Bearer, Basic, raw header, Spotify mint. Real APIs need query-string keys (`?api_key=`), HMAC request signing (Stripe/Slack/GitHub webhook styles), AWS SigV4, mTLS, cookie auth, and a "two secrets" shape (key id + secret). `InjectMode` exists as a type and is never validated; unknown values silently fall through to Bearer.

**4.4 Response handling.** Only `{status, body}` comes back. Pagination `Link`, `X-RateLimit-*`, and `Content-Type` are lost. No streaming, 10 s fixed timeout, 256 KiB cap, no binary. No schema-based field masking; a "dry run / explain" tool ("which item, which grant, would this be allowed?") would remove most of the `ambiguous`/`host_mismatch` back-and-forth.

**4.5 Local and hosted are two products.** Local MCP cannot inject (only `vault run` can, with a self-asserted `--agent` flag). Either give local the same five tools with `http.request` over the same connector, or narrow local to "a dev shim for the hosted API" and say so. Two consoles, two tool vocabularies, and two JSON-RPC handlers are the cost of not deciding.

**4.6 Deploy plane leaks into product.** Staging and production are two Fly apps with two databases and two account systems; an operator who wants a pre-prod agent must create a second account on `staging.botpasses.com`. Meanwhile the per-item `environment` field (staging|production) is a different concept that the console renders as "Environment plane production" in the rail. Decide: either environments are a per-item tag inside one account on one plane (most SaaS), or planes are the vendor's own pre-prod and never user-facing. Today it is both, and the store dialog's default of `staging` on the production plane is the symptom.

**4.7 Team, recovery, billing.** `org_members` and roles exist in the schema with no invite, member list, or role UI. `addMember` is unreachable. There is no account recovery when TOTP and backup codes are lost (by design, but undocumented). No email change. No pricing, plan limits, or billing. None of this is needed for the first user; all of it is needed before the tenth.

**4.8 Positioning.** The README is a better landing page than the landing page. The differentiators that exist and are unsaid: first-party OAuth AS on the same origin, the access ledger with immediate JWT revoke, the `collect_url` flow (the human types the key on Botpasses, never in chat), prompt grants that survive a failed origin call, the honest trust model, connector hardening, canary tests in CI. Competitors to name: 1Password/Doppler/Infisical (secrets for humans and CI), Composio/Arcade/Nango (tools for agents, they hold your tokens), env vars (leak into context). The pitch is one sentence: "your agent can call the API; it cannot read the key."

---

## 5. The plan

Five phases. Phase 0 is days. Phases 1 and 2 run in parallel over about a month. Phase 3 is the product work that follows. Phase 4 is hygiene that can start any time and should finish before the first external contributor. Every task names files and an acceptance test. All schema changes are expand-only.

### Phase 0: stop the bleeding (this week)

| # | Task | Files | Done when |
| --- | --- | --- | --- |
| 0.1 | Enforce MFA at sign-in (S1). Add `mfa_at` column; pending sessions; `POST /api/auth/totp/verify`; require current code for re-enroll; invalidate unused backup codes on re-enroll; delete pending session on upgrade; route enrolled users to the TOTP step in `AUTH_JS`. | `operator-identity.ts`, `identity.ts`, `hosted-assets.ts`, `schema.ts`, `http-auth-routes.ts` | Test: enroll, logout, OTP verify, `GET /api/items` 403 `mfa_required`; TOTP verify then 200. Re-enroll without code is 403. |
| 0.2 | Tenant-scope OAuth clients (S2). Resolve `sub` to org, then `(org_id, oauth_client_id)`; unique index; scope oidc payload destroy by account. | `identity.ts`, `postgres.ts`, `sqlite-hosted.ts`, `oauth-as.ts`, `oidc-adapter.ts`, `schema.ts` | Two orgs, one DCR id: each JWT lists its own org's items; revoke in A leaves B's refresh token valid. |
| 0.3 | Fix OAuth client environment (D1). Issue with the plane's default environment; add `POST /api/clients/:id/environment` (operator); remove `environment` from MCP tool schemas since it is ignored. | `oauth-as.ts:280`, `http.ts`, `hosted/mcp.ts`, docs | On production plane an OAuth client sees production items. |
| 0.4 | Close the approval-link hole (S3). Model channel cannot set `operator_email`; `/approve` GET renders a confirm form, POST approves with CSRF; escape `client.name` in email HTML. | `http.ts:685,752`, `kernel.ts:630-639` | Model bearer with `operator_email` is 400; GET `/approve?token` does not change grant status; `<script>` in client_name is escaped in the email fixture. |
| 0.5 | CSRF on cookie `/mcp` (S4). Require `X-CSRF-Token` and same-origin `Origin` for cookie principals; environment from the client record, not the body. | `http.ts:332-378,856-869` | Cross-origin cookie POST to `/mcp` is 403. |
| 0.6 | Set the GitHub default branch to `dev` (I1). Run `backup-prod.yml` by dispatch, download the object, run `restore.md` into a scratch Neon branch once. | GitHub settings, `docs/ops/restore.md` | A dated `botpasses-*.dump.enc` exists in R2 and restores. |
| 0.7 | Fly health checks and drain (I2, S16). `[[http_service.checks]]` on `/ready`; `kill_timeout = 30`; auth on `GET /mcp`; `closeAllConnections()` after a 25 s deadline; catch `PostgresStore.open` and exit 78; `.catch` on `startHosted`. | `fly.*.toml`, `http.ts:246`, `main.ts` | `fly checks list` shows passing; SIGTERM exits within 30 s with an open SSE client. |
| 0.8 | Indexes (I3). `clients(hashed_secret)` unique partial, `clients(org_id, oauth_client_id)` unique, `operator_sessions(user_id)`, `email_otp_challenges(email, sent_at)`, `approval_challenges(grant_id)`, `backup_codes(user_id)`, `need_items(org_id,status)`, `grants(client_id,item_id,status)`. | `schema.ts` | `EXPLAIN` on `findClientByHashedSecret` is an index scan. |
| 0.9 | Console blockers (D2, D3, D4, D6). Cancel via `formmethod="dialog"`; backup-codes step with copy/download and explicit Continue; move `display:flex` off `<td>` and set `table-layout: fixed`; Sign out in the rail. | `operator-page.ts`, `hosted-assets.ts:136`, `console-css.ts:279`, `console-js.ts` | Playwright: click Cancel closes dialog; backup codes visible before redirect; Actions column visible at 1280; Sign out clears the cookie. |
| 0.10 | Email notifications for agent grants (D5). Kernel derives operator emails from org members when `operatorEmail` is absent. | `kernel.ts:556-650`, `store/types.ts` (`listMembers` exists) | MCP `request_grant` with a sender configured produces one email per member and `notify_failed: false`. |
| 0.11 | Prod deploy gate (I4). `environment: production` with a required reviewer; verify `staging_sha` is an ancestor of `origin/dev`; add Postgres service and `npm audit`; pin `setup-flyctl` to a SHA; `permissions: contents: read` on all workflows. | `.github/workflows/*.yml` | Dispatch with a SHA not on `dev` fails before deploy. |
| 0.12 | Site quick fixes (D10, D11). Strip `.html` in canonical; `Sitemap:` line in robots; drop `/sitemap.xml` from `PUBLIC_STATIC`; fix `staticHeaders` so hashed assets are `immutable` and HTML is `no-cache`; 308 `*.html` and trailing `/` to canonical; load Pagefind UI in `Docs.astro` or remove the input. | `site/src/layouts/Base.astro`, `static-site.ts`, `http.ts:1000` | Tests: canonical equals sitemap URL for every page; `_astro/*` has `immutable`; docs search returns results. |

### Phase 1: security and correctness (weeks 2 to 4)

| # | Task | Files | Done when |
| --- | --- | --- | --- |
| 1.1 | Grant dedupe and full revoke (S6). `requestGrant` returns the open grant for the pair; `revokeGrant` revokes all active rows for the pair; limiter inside `kernel.requestGrant`; mark `session` grants `expired` on read. | `kernel.ts`, `mcp-http.ts`, `http.ts` | Ten `request_grant` calls with a standing policy yield one active grant; revoke then `http.request` is `inject_denied`. |
| 1.2 | Redaction set (S7). Encodings (Basic base64, URL, JSON-escaped, hex), recursive OAuth key walk, redact before truncate, drop body-wide last-4 masking. | `connector.ts`, `redact.ts` | Echo-origin test with a Basic item: body contains neither the secret nor its base64. |
| 1.3 | Consent and device pages show the client (S5, S12). Look up `client_name` and redirect host; tighten scheme allowlist to the named list; render xsrf on `/device`; require `decision === "allow"`; short OP session TTL and end it on logout. | `oauth-interactions.ts`, `auth-pages.ts`, `oauth-as.ts`, `http-auth-routes.ts` | Consent HTML names the client and host; device POST succeeds; logout then authorize re-prompts. |
| 1.4 | Proxy and cookies (S10). `provider.proxy = true` when hosted; test with `secureCookies:true` and `x-forwarded-proto`. Exercise the real authorize, consent, code, token, refresh path in one test. | `oauth-as.ts`, `test/` | End-to-end OAuth test green with secure cookies. |
| 1.5 | Limiters and TOTP brute force (S8, D16). `Fly-Client-IP`; bounded maps; DB-backed TOTP failure counter with lockout; move `pendingTotp` and OTP IP limiter into the store, or write "one machine, do not scale" into both tomls and README. | `operator-identity.ts`, `oauth-as.ts`, `schema.ts` | Spoofed XFF does not bypass; 10 wrong TOTP codes lock for 15 min. |
| 1.6 | Identity secrets under a rotatable key (S9). Identity DEK wrapped by KEK; `rotateKek` re-wraps it; Spotify state sealed under it. | `operator-identity.ts`, `kernel.ts:220,1032` | Rotate KEK then TOTP verify passes. |
| 1.7 | Item AAD binding (S11). AAD includes item id, hosts, inject; migrate-on-read for existing rows. | `kernel.ts` | Swapping two ciphertexts fails to decrypt. |
| 1.8 | Error hygiene and audit truth (S13, S14, S15). Generic 500 with request id; `readJson` wraps `SyntaxError`; capture only unknown errors; audit `inject` after send; exact session hash match; owner-only for others' sessions; complete `deleteOrg`; filter revoked in `ensureModelClient`; `RETURNING` in the limiter. | `http.ts`, `kernel.ts`, `postgres.ts`, `rate-limit.ts` | Pg error text absent from responses; `host_mismatch` writes no `inject` row. |
| 1.9 | Migrations made real (I5). Runner applies `migrations/NNN_*.sql` under `pg_advisory_lock`, records `schema_migrations`, runs via `DATABASE_URL_DIRECT` in a Fly `release_command`; test asserts `schema.ts` equals concatenated SQL or delete `schema.ts` DDL. | `migrations/`, `store/postgres.ts`, `fly.*.toml`, `Dockerfile` | Boot no longer runs DDL; concurrent boot test does not error. |
| 1.10 | Store parity and network path tests (I6). Parametrise hosted tests over `[sqlite, postgres]` when `DATABASE_URL` is set; add a `fetchPinned` test against a local TLS server (Host, SNI, abort, 3xx not followed). | `test/helpers.ts`, `test/*` | `postgres.ts` at 85 percent or better; `connector.ts:186-239` covered. |
| 1.11 | Pool, timeouts, sweeps (I7, I8). `connectionTimeoutMillis`, `statement_timeout`, `idleTimeoutMillis`, `application_name`; timeouts on Resend and Sentry fetch; hourly sweep of expired OTP, sessions, oidc payloads, challenges, needs, `rate_hits`; `consume()` keeps TTL; indexed columns for `uid`, `user_code`, `grant_id` on `oidc_payloads`. | `postgres.ts`, `oidc-adapter.ts`, `main.ts`, `email.ts`, `observe.ts` | Tables do not grow without bound over a 24 h soak. |
| 1.12 | CI hardening (I9, I10). `eslint` with typescript-eslint strict and `no-floating-promises`; coverage threshold via `--experimental-test-coverage`; gitleaks; Dependabot `github-actions` + `docker`; pin `node:22.x` digest; pin `aws4fetch` or vendor the R2 PUT into `scripts/hosted-backup.ts`; install `postgresql-client-<major>` matching Neon; `.dockerignore` `**/node_modules`. | `.github/`, `Dockerfile`, `package.json` | CI fails on a floating promise; audit and lint run on every push. |
| 1.13 | Observability (I11). `@sentry/node` or the envelope endpoint; request id header and structured request log; auth-event log lines for OTP and TOTP failures; alert on `kek_raw_fallback` and backup-job failure. | `observe.ts`, `http.ts`, workflows | A failed backup pages someone. |
| 1.14 | Negative approval tests (S6 note). Model bearer on `approve-by-code`, `/approve`, `/api/grants/:id/approve` is 403. Fix `approveByCode` so a wrong code increments only the matching challenge (D14). | `test/machine-tokens.test.ts`, `kernel.ts:718` | Tests exist and pass. |

### Phase 2: console, site, and docs (weeks 2 to 5, parallel with Phase 1)

**2.1 Vocabulary and copy (one pass, all surfaces).** Adopt: *credential* (the stored thing), *agent* (client), *approval* (grant), *request* (pending grant or need), *environment* (staging/production tag), *activity* (audit). Remove every em-dash. Replace "this origin" with the hostname. Move Grok and Spotify text to docs behind disclosures; the only vendor names in generic UI are in a "works with" list. Say the retry rule once, in the approved card. Rename "Environment plane production" to nothing (see 4.6) or "Production" as a small label. Files: `operator-page.ts`, `console-js.ts`, `console-access-js.ts`, `auth-pages.ts`, `hosted-assets.ts`, `store-form-fields.ts`, `prompts/mcp-hosted.ts`, `site/src/pages/**`.

**2.2 Auth pages.** Hide the send form after send and show "Sent to x@y. Change" with a Resend button and countdown. Attempts-remaining on wrong code. Put the raw otpauth URL behind "Show URL". Backup-codes step (0.9) with download. Add a TOTP step page for sign-in (0.1). Wrap the brand in `<header>`. One page for sign-up and sign-in with the heading chosen by route.

**2.3 Console information architecture.** Keep the three-panel rail but fix what the panels are:

- *Inbox*: cards as today, plus timestamp, code expiry countdown, Deny, and a 15 s poll (or SSE) so approvals do not need a reload.
- *Credentials* (was Vault): table with `table-layout: fixed`, search, environment and kind filters, sort by name or last used; row click opens a detail drawer (created, rotated, last used, agents with approvals, per-item revoke, edit, rotate, delete). Store dialog: environment defaults to the plane's environment with a one-line explanation; allowed hosts explained ("only these hosts will ever receive this credential"); name pattern hint and auto-uppercase client-side; provider-specific hints only when a provider is picked.
- *Agents* (was Access): a two-step "Connect an agent" card at top (1. copy MCP URL, 2. issue token or "connect with OAuth from the agent", done state with the token in a modal, Copy primary, "I saved it" dismiss). Below it, tabs: Agents, Approvals, Sessions, Activity. Activity rows humanised ("cursor requested STRIPE_SECRET_KEY", "Token issued to claude-desktop") with `<time datetime>` and relative times, filter by agent and credential, paging. Sessions show created, last seen, and "this device".
- *Account* (new, in the rail footer): email, authenticator (re-enroll with current code, regenerate backup codes, remaining count), sessions shortcut, sign out. Bootstrap token moves to a `/console?breakglass` route or the local console only.
- Confirm dialogs are specific: "Delete GITHUB_TOKEN? Agents with an approval lose access now." with a matching button label. Rotate says the old token stops working.
- Routing: `pushState` plus `hashchange`/`popstate`; deep links load the right panel and filter.
- Every loader has try/catch and an inline network-error state; submit buttons disable in flight; flashes auto-clear and can be dismissed; `role=alert` on error boxes; `aria-labelledby` on dialogs; `scope=col`; hidden fields are `type=hidden`; live region for the once-shown token.

**2.4 Design system.** One token source: the site imports `cssVariables()` from `src/brand-visual.ts` (or a generated CSS file) instead of hand-copied hex in `global.css` and `design.astro`. Add `--warn` (amber) for pending and once-shown states; reserve the green for actions; links get an underline rather than the accent alone. A second display size (Fraunces 1.25 rem) for card and panel titles; `th` at 0.85 rem; pills get a background. Light theme via `prefers-color-scheme` on the same tokens (contrast tests already exist; extend them). Unify radius, card, and button styles between site and console. Serve the mark from `hosted-assets.ts`. Preload Fraunces 700; inline the 11 KB site stylesheet; one font pipeline.

**2.5 Front-end code.** Move client JS to typed modules under `src/hosted/client/` compiled by `tsc` to `/assets/*.js` (no bundler). Share `store-form-fields.ts` with the browser. Add an auto-escaping `html` tagged template so `escapeHtml` cannot be forgotten. Delete the dead `#access-revoke` dialog and the test that pins it. Replace regex-over-source tests with one Playwright smoke test (sign-up, enroll, store, connect, approve, revoke) at 1280 and 390 px, run in CI with the pre-installed Chromium.

**2.6 Homepage.** Below the hero, in order: (a) three steps with the real `http.request` JSON and a redacted result; (b) a "what the model sees / what the API sees" split; (c) works with Claude, Claude Code, Cursor, ChatGPT, Grok, any MCP client; (d) the trust model in plain words, including "grant-vault, not zero-knowledge" and who can decrypt; (e) open source, MIT, self-host, "free while in beta"; (f) FAQ (is this a password manager, what if the agent is prompt-injected, what do you log, how do I revoke). Add GitHub, support email, and security disclosure to the footer. Real `og.png` with wordmark and tagline; `og:url`, `og:site_name`, `twitter:card`; unique descriptions per page; `theme-color`.

**2.7 Security page.** Import the surfaces table from `docs/security/threat-model.md`, the encryption and KMS paragraph from the README, connector hardening, the canary-test claim, the access-ledger revoke story, and links to the ADRs. Fix "injected into tool or runtime env only" to describe the hosted path truthfully.

**2.8 Docs.** Collapse `how-to/connect-*` into `connect/*`. Each connect page is a real page with copy-paste config: Claude Desktop connector, `claude mcp add`, Cursor `mcp.json`, ChatGPT connector, Grok `grok mcp add`, generic remote MCP. Add Troubleshooting (host_mismatch, mfa_required, connect card keeps appearing, 409 on code reuse, need_item), FAQ, Install, Self-hosting (Fly, Neon, Cloudflare, KMS), Rate limits, Security disclosure. Publish the full changelog from `CHANGELOG.md`. Move docs to Markdown content collections with frontmatter so the copy-voice rule applies, descriptions are real, and sidebar and prev/next are generated. Label model-facing text in the MCP reference as "instructions the server sends to the model" or move it to a collapsible. Fix drift: `task_id` on `request_grant`, `kind`/`environment` on `find_items`, undocumented routes. Add `llms.txt`, `security.txt`, `404.astro`, `BreadcrumbList`. Wrap tables in `overflow-x: auto`; style `h3`; 24 px link targets. Content tests: canonical equals sitemap, unique descriptions, assets immutable, internal link check, Pagefind present, mobile overflow.

### Phase 3: product depth (weeks 5 to 10)

| # | Task | Notes |
| --- | --- | --- |
| 3.1 | Scoped approvals (4.1). `request_grant` and `http.request` carry `host`, `method`, `path`; a grant stores optional `methods`, `path_prefixes`, `max_calls`, `expires_at`; inbox card shows the scope; `item_standing` gets an expiry; `session` TTL is a parameter. | Schema expand: new nullable columns on `grants` and `policies`. Enforce in `prepareConnector`. |
| 3.2 | Provider abstraction (4.2). `providers` as data: token host, token auth style, grant types, scopes, redirect rules, redaction keys, user-path hints. Ship Spotify, GitHub App, Google, Slack, Stripe Connect. Generic client-credentials mint and refresh-token connect in `mcp-http.ts`; console "Connect provider" picks from the list. Remove `accounts.spotify.com` from `connector.ts`. | The MCP prompt drops all vendor text and gains "Botpasses handles OAuth token minting for known providers". |
| 3.3 | Inject modes (4.3). Validate against `InjectMode`; add `query:<param>`, `hmac:<scheme>`, `sigv4`, `cookie`, key-id + secret pairs. | Unknown inject is 400, never silently Bearer. |
| 3.4 | Response handling (4.4). Return whitelisted headers (`link`, `x-ratelimit-*`, `content-type`, `retry-after`); configurable timeout up to 30 s; `explain` tool (or `dry_run: true` on `http.request`) answering which item, which grant, allowed or why not. | Also fix 4xx steering: "the request was wrong, change path or body" vs 5xx "transient, retry once". |
| 3.5 | Tool surface (D12, DX). Rename `http.request` to `http_request` (keep the old name as an alias for one release); fold `find_items` into `http_request` results; `request_grant` takes scope; `list_items` includes hosts; unify local and hosted tool names; add `destructiveHint` on `http_request`. | Update `mcp-steer.ts`, docs, tests, prompts. |
| 3.6 | Environments (4.6). Decide: recommended is one plane per account with `environment` as a per-credential tag and per-agent binding, and `staging.botpasses.com` becomes vendor pre-prod only. Remove "Environment plane" from the UI; default store environment to the agent's environment. | If keeping planes user-facing, document why and add an account-level plane switcher. |
| 3.7 | Team and account (4.7). Members list, invite by email, roles owner/operator, remove member; email change with re-verify; documented no-recovery policy with a "print your backup codes" nudge; org name. | `addMember` exists; add store `listMembers` UI, `inviteMember`, `removeMember`. |
| 3.8 | Local plane (4.5). Give `vault mcp` the same five tools with `http_request` over the same connector and the local console the same UI, or reposition local as a dev shim. | Delete `src/operator-page.ts` either way. |
| 3.9 | Billing hooks. Plan limits (credentials, agents, calls per month) as config with a free tier; usage counters already exist in `access-usage.ts`. Stripe later. | Needed before opening sign-up publicly. |

### Phase 4: repository and architecture hygiene (any time; finish before external contributors)

| # | Task |
| --- | --- |
| 4.1 | Move the agent harness out. Delete `.cursor/plans/*`, `.cursor/canvases/`, `.loadout/`, `processes/`, and the loadout docs (`INSTALL.md`, `docs/usage.md`, `docs/catalog.md`, `docs/agentic-patterns.md`, `docs/external-practices.md`, `docs/agent-harness-engineering.md`, `docs/loop-engineering.md`, `docs/loadout/`). Keep `AGENTS.md`, a CLAUDE.md under 60 lines, and `loadout.lock.json` with assets fetched, not vendored. Write a real `INSTALL.md` for Botpasses. |
| 4.2 | Docs: dedupe `docs/plans` vs `.cursor/plans`; renumber the duplicate ADRs (0003b and 0004b become 0006 and 0007 with a note); sync `package.json`, CHANGELOG, and MCP `serverInfo.version`; document `FLY_APP_NAME`, `VAULT_BIND_HOST`, `VAULT_PORT`, `VAULT_SITE_ROOT`; state the `site/dist` prerequisite or add a `pretest` that says so. |
| 4.3 | Scripts: `lint`, `test:coverage`, `test:pg`, `site:build`, `dev`; one `node` incantation in one place. |
| 4.4 | Split `http.ts` into route modules (auth, items, grants, clients, access, oauth, mcp, static); split `kernel.ts` (items, grants, clients, needs, providers, kek); collapse the two stores' duplicated mappers behind shared row types; use `oidc-provider`'s own types. |
| 4.5 | Delete dead code listed in 3.6; replace `err.message === "inject_denied"` with typed errors; rename origin `status` to `origin_status`; single `writeHead` wrapper; deduplicate `publicGrant`, `optional`, `nowIso`, redactors, `FORBIDDEN`. |
| 4.6 | `cli.ts` lazy-loads hosted dependencies so `vault set` does not import `pg` and the AWS SDK. |
| 4.7 | Replace source-grep tests with behaviour tests; keep one tripwire for "zero-knowledge" in public copy. |

---

## 6. Sequencing, dependencies, and what not to do

- 0.1 and 0.2 first, in one PR each, with their tests written before the fix so the tests are seen to fail. 0.6 is a settings change and a manual restore drill; do it the same day.
- 0.3 depends on nothing but should land before any external OAuth user, since today they silently get staging.
- 1.9 (real migrations) must land before 1.1, 1.5, 1.6, 1.7, and 3.1, since all add columns. Until then keep adding to `schema.ts` expand-only.
- 2.1 (vocabulary) first in Phase 2, because every later screen and page uses the words.
- 3.2 (providers) before 3.5 (tool surface), because the prompt and tool descriptions change shape once vendor text leaves.
- 3.6 (environments) is a decision, not code. Make it before 2.3 finalises the store dialog, or the dialog gets rebuilt twice.
- Do not add a second Fly machine until 1.5 and 1.9 are done.
- Do not enable AgentPass until S18 is rewritten.
- Do not add Redis or a session store to MCP; the stateless design is correct and ADR D-09 already says so.
- Do not claim zero-knowledge anywhere. The existing tripwire test is right.
- Do not chase the `.html` canonical fix with a blanket trailing-slash rewrite that changes `/console/`; the console already 308s and tests pin it.

## 7. What to measure

- Security: time from sign-in to MFA-verified session is never zero for enrolled users; zero cross-org JWT resolutions in a two-org test; redaction test corpus passes for every inject mode.
- Reliability: `fly checks` green; p95 `/mcp` latency under 300 ms excluding origin time; backup object present every day; restore drill quarterly.
- Product: first-credential time (sign-up to a successful `http_request`) under five minutes in a scripted run; inbox approve to agent retry under ten seconds with polling.
- Quality: `postgres.ts` coverage 85 percent or better; lint clean; no file over 600 lines in `src/hosted/`; product files are at least 80 percent of tracked files.

## 8. Appendix: commands and artefacts

Reviewer artefacts (scratchpad, not committed): console screenshots `shots/01…23`, site screenshots `{home,docs,connect-grok,security,mcp-tools}-{1280,390}-*.png`, axe output `a11y.json`, logs `npm-ci.log`, `tsc.log`, `test-nopg.log`, `test-pg-cov.log`, `site-build.log`.

Reproduce the gates:

```bash
npm ci
npm --prefix site ci && npm --prefix site run build
npm test
npm run typecheck
DATABASE_URL=postgres://vault:vault@localhost:5432/vault node --experimental-strip-types \
  --disable-warning=ExperimentalWarning --test --experimental-test-coverage test/*.test.ts
```

Reproduce the headline security findings without a browser:

```bash
# S1: identity.ts derives readiness from the user row, not the session
grep -n "totpEnabled(loaded.user)" src/hosted/identity.ts
# S2: global lookup by DCR client id, no org predicate
grep -n "oauth_client_id = \$1 OR clerk_oauth_user_id" src/store/postgres.ts
# D1: OAuth clients pinned to staging
grep -n 'environment: "staging"' src/hosted/oauth-as.ts
# D5: only the REST route passes operatorEmail
grep -rn "operatorEmail" src/hosted/
# I1: default branch is the empty main
git ls-remote --symref origin HEAD
```
