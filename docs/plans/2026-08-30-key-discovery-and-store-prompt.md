# Plan: Key discovery, operator collect, inject without visibility

Canonical interactive plan (Build): `~/.cursor/plans/key_discovery_collect_65504298.plan.md`. This file is the create-plan research twin. Do not implement from this file alone.

Reviewed three times 2026-08-30.

Task file: [`.loadout/tasks/key-discovery-and-store-prompt/TASK.md`](../../.loadout/tasks/key-discovery-and-store-prompt/TASK.md)

## 1. Summary

- Problem: Operators can store items on a crude hosted form, but agents cannot **find** the right named credential when names collide or nothing exists. A miss today is a 404 (`Unknown item`) with no operator prompt. There is no secure collect page for "the bot needs a Spotify token." Inject already exists (`http.request` / `vault run`) and must stay the only path that touches values.
- Outcome: An operator can add a key on Botpasses (console + a focused collect page). When a model client looks up a credential and finds none (or several), MCP/API returns **names and metadata only**, plus a **non-capability** Botpasses-origin `collect_url`. The human signs in on that origin and types the secret. After store and a prompt grant, `http.request` attaches the credential on the vault process; the model never sees the value.
- Approach: Add structured `find_items` (exact name and/or exact allowlisted hostname, cap 5). On zero matches, create a `need_item` row and return `collect_url` **without** a query HMAC (MCP already returns grant `approval_code`, never `/approve?token=`). Collect POST requires an operator bearer (`VAULT_BOOTSTRAP_TOKEN` session), same as `POST /api/items`. Keep protocol `2024-11-05`. Do not add `get_secret`. No new npm dependencies. Do not change grant magic-link token JSON in this change.

## 2. Scope

### In scope

- Hosted operator console: clearer store form (password field, inject enum, host help).
- Hosted collect page: `GET /collect/:needId` (public HTML, no secret). Submit via `POST /api/need-items/:id/fulfill` with operator Authorization. Page shows requesting **client name** and `task_description`.
- Hosted MCP + REST: `find_items`; missing-item path on MCP `request_grant`, MCP `http.request`, and REST `POST /api/grants/request` returns `need_item` + `collect_url` instead of a bare 404.
- Ambiguous match: up to 5 public item summaries (name, last-4, **allowed_hosts**, inject, kind). Note: today's MCP `list_items` omits hosts (`src/hosted/mcp.ts`); `find_items` must include them.
- Name+host mismatch: `status: "host_mismatch"` (item exists, host not on allowlist). Do not create a need.
- Inbox lists pending needs next to pending grants.
- Fulfill: kernel encrypts in memory, then **one** store method `persistFulfill` on a single postgres client (INSERT item, INSERT grant, `UPDATE need_items SET … WHERE id = $1 AND status = 'pending'`, INSERT audit). Zero rows updated is 409. Not a generic `withTxn` around `createItem` (that would use `pool.query` and would not be atomic).
- Pending-need insert: `insertPendingNeed` INSERT, on unique violation SELECT the existing pending row and return it (no driver-error handling in the kernel).
- Isolation tests: canary secret never appears in MCP payloads, collect HTML, inbox JSON, or mocked agent transcripts. `collect_url` never contains `t=` or an HMAC.
- `deleteOrg` deletes `need_items` for that org.
- Need creation is rate-limited **inside** `ensureNeedItem` (covers find, grant miss, `http.request` miss). Do not rate-limit successful `http.request`.
- Docs + changelog in the same change.

### Non-goals (with rationale)

- **MCP form-mode elicitation of the secret** — spec forbids requesting passwords/API keys in form mode; the value would transit Grok/Claude.
- **Bumping hosted MCP protocol to `2025-11-25`** — `elicitation/create` is a server-to-client request that needs Streamable HTTP/SSE. Today's hosted MCP is request/response JSON-RPC (`handleHostedMcpRpc`). A protocol bump would break clients that only speak `2024-11-05`.
- **JSON-RPC `-32042` as the only signal** — clients that stringify errors drop `error.data`. `need_item` JSON lives in the tool **content text**. `isError: true` for `need_item` and `host_mismatch` so the call is blocking. `found` / `ambiguous` use `isError: false`.
- **HMAC / magic query on `collect_url`** — MCP spec MUST NOT hand the client a pre-authenticated URL. Grant flow already keeps HMAC on email (`/approve?token=`), not in MCP. Collect follows that split: MCP gets a path-only URL; POST requires operator session.
- **Email collect links** — Resend already sends grant magic links. Wiring collect into email is a separate change. Inbox + `collect_url` + console sign-in cover a single operator.
- **Third-party OAuth (Spotify authorization code, Google, GitHub)** — out of this change. Different token type than a dashboard client secret.
- **Transparent MITM agent proxy (Infisical Agent Proxy shape)** — hosted inject is already the connector (`http.request`).
- **Local sqlite `need_items` + loopback collect URLs** — Grok Bot cannot reach `:8788`. Local MCP on miss returns `need_item` with a message to use `vault store` / local console, and no `collect_url`.
- **Semantic keyword matching** (`/spotify/i` on names or task text) — `no-regex-for-semantics`. The agent supplies `host` or `item_name`; the vault matches structurally.
- **Vault-side LLM classifier** — extra API key, fail-closed anyway. Structured fields already exist.
- **Clerk login on the collect page** — Clerk is unwired. Bootstrap token session is operator auth.
- **Changing grant HMAC JSON** (`kind` field on `mintApprovalToken`) — unused if collect does not use HMAC. Leave grant tokens as `{ grantId, exp }`.
- **`get_secret` / returning values on MCP** — product invariant.
- **New npm dependencies**.

### Assumptions (labeled; must not block implementation)

- **A-1.** Grok custom MCP is URL + header auth. xAI docs do not describe elicitation, `-32042`, or protocol `2025-11-25`. Operator prompt: model quotes `collect_url`, and/or operator uses hosted inbox.
- **A-2.** The credential the operator types is a Botpasses item value (for Spotify: a Web API access token stored as `SPOTIFY_TOKEN` with host `api.spotify.com` and inject `bearer`), not a Spotify dashboard client secret unless they choose a header inject.
- **A-3.** One pending need per (`org_id`, `client_id`, `environment_id`, `suggested_name`, `host`) while `status = 'pending'`. `host` is `TEXT NOT NULL` (empty string when the agent passed only `item_name`). A second find reuses the same need id. Pending rows with `expires_at` in the past are set to `cancelled` before a new insert.
- **A-4.** After fulfill, a prompt grant exists for that client+item (consumed on first `http.request`). Standing policy remains a separate console action. Collect is consent to store and to that one prompt grant.
- **A-5.** `collect_url` is `{VAULT_PUBLIC_URL}/collect/{needId}` with no query string. `VAULT_PUBLIC_URL` is `https://staging.botpasses.com` or `https://botpasses.com`.
- **A-6.** `GET /collect/:id` is unauthenticated HTML (need UUID is unguessable). POST fulfill is `requireOperator` only. Model and trusted bearers receive 401/403.
- **A-7.** Existing `originOk` in `src/hosted/http.ts` applies to collect GET/POST (same as `/`). Browser GET has `Host` of our origin. Cross-site POST with a foreign `Origin` is 403.
- **A-8.** `NeedItemError` extends `HttpError` with a public `payload` object (`status`, `collect_url`, `suggested_name`, `host`, `client_name`, `need_id`, `message`). MCP `callHostedMcpTool` catch and HTTP `sendError` emit that payload. A 404 string `"Unknown item"` is not an acceptable miss result.
- **A-9.** Fulfill requires at least one allowed host (same as `createItem` `#assertHosts`). Empty host list is 400.
- **A-10.** `GET /collect/:id` is registered in `route()` beside `GET /` (after `originOk` and after `auth()`, which returns `undefined` when there is no bearer and does **not** throw). Copy the GET `/` placement; do not put collect HTML behind `requireOperator`. There is no unauthenticated `GET /api/need-items/:id` JSON. The HTML is server-rendered from `kernel.getNeed`.
- **A-11.** `createHostedServer` already constructs one `OrgRateLimiter`. Pass **that same instance** into `HostedKernel`. Do not construct a second limiter in the kernel.
- **A-12.** Live `fail(message)` always emits `{ error: message }`. `find_items` blocking statuses (`need_item`, `host_mismatch`) are returned as the full JSON object in `content[0].text` with `isError: true`, via a helper that does **not** call `fail(err.message)`.
- **A-13.** Fulfill environment, `client_id`, and `org_id` come from the need row, not the POST body. The operator may edit name, hosts, inject, kind, username, and value.

### Open questions

None.

## 3. Current state (in-repo, evidence-based)

### Files read (path — why relevant)

| Path | Why |
| ---- | --- |
| `AGENTS.md` | Invariants: no `get_secret`, inject into runtime only, port 8788 |
| `README.md` | Hosted MCP tool list, Grok Bot connector, grant policies |
| `src/hosted/mcp.ts` | Tools; protocol `2024-11-05`; `list_items` omits `allowedHosts`; `isError` via `fail()` |
| `src/hosted/kernel.ts` | `createItem`, `requestGrant` 404, `prepareConnector` 404, `mintApprovalToken` email-only; `HostedKernelOpts` has no limiter today |
| `src/hosted/connector.ts` | Bearer/basic/header inject; `redactConnectorBody` |
| `src/hosted/operator-page.ts` | Public HTML store form, inbox, Grok token issue |
| `src/hosted/http.ts` | `/` public HTML after `originOk`; `POST /api/grants/request`; org rate limiter on `request_grant` only |
| `src/hosted/auth.ts` | `avm_` model vs operator bootstrap vs `avt_` trusted |
| `src/hosted-types.ts` | `ItemPublic` includes `allowedHosts` |
| `src/hosted/ssrf.ts` | Exact hostname allowlist, no wildcards |
| `src/ids.ts` | `normalizeSecretName` |
| `src/redact.ts` | Forbidden JSON keys include `token` and `value` |
| `src/store/schema.ts` | Hosted DDL; migrate runs this blob |
| `src/store/types.ts` | `VaultStore`; no `persistFulfill` yet |
| `src/store/postgres.ts` | `deleteOrg` uses BEGIN; does not know `need_items` |
| `src/store/sqlite-hosted.ts` | Same `deleteOrg` BEGIN pattern |
| `src/mcp.ts` | Local tools: list/grant only |
| `src/brand.ts` | `MCP_INSTRUCTIONS_HOSTED` |
| `migrations/001_init.sql` | Expand pattern |
| `test/isolation.test.ts` | Canary must not appear after store/grant/use |
| `package.json` | No extra runtime needed |
| `CHANGELOG.md` | Same-change user-visible entry |
| `docs/plans/2026-08-30-grant-vault-product.md` | 1Password names-only, Infisical connector |

### What exists today

- Operators store items via `POST /api/items` (operator bearer).
- Model MCP lists items but **drops** `allowed_hosts` in the tool result.
- Unknown `requestGrant` / `prepareConnector` is HTTP 404 `"Unknown item"`.
- Grant HMAC is emailed (`${publicUrl}/approve?token=`). MCP sees `approval_code` only.
- Inject: `http.request` decrypts in-process, attaches headers, redacts body.
- `originOk` rejects foreign `Origin`. Missing `Origin` is allowed (same-origin navigation).
- Rate limit: MCP `request_grant` and `POST /api/grants/request` only.

### Data flow (entry → persistence → output) today

```
Operator POST /api/items → HostedKernel.createItem → AES-GCM envelope in items row
Model list_items → names/last4 (no hosts in MCP mapping)
Model request_grant(item_name) → grants row pending|active + approval_code
Email (if configured) → /approve?token=HMAC
Model http.request → decrypt → HTTPS to allowlisted host → redacted body to MCP
```

### Gaps / constraints / contradictions with the task (including draft-plan contradictions)

- There is an add-key form, not a collect-on-miss flow.
- Draft plan returned HMAC on `collect_url` in MCP. That **contradicts** live grant design and MCP "MUST NOT provide a pre-authenticated URL." Review retracts HMAC-on-collect.
- `list_items` MCP mapping omits hosts, so agents cannot filter by hostname without `find_items`.
- `no-regex-for-semantics` forbids classifying "spotify" with a word list.
- Hosted MCP cannot send `elicitation/create`.

### Reusable components / deps already installed

- `ItemPublic`, `assertSafePublicObject`, `redactConnectorBody`, `normalizeSecretName`, `assertAllowedHostname`, `originOk`, `OrgRateLimiter`, operator HTML, isolation `CANARY`, postgres/sqlite `BEGIN` in `deleteOrg`.
- No new packages.

## 4. External research

### Questions investigated (original)

1. How does MCP 2025-11-25 expect servers to collect API keys without the client seeing them?
2. What do 1Password Environments MCP and Infisical Agent Proxy return to agents?
3. How should ambiguity be presented to an LLM tool-user?
4. Does Grok Bot support URL-mode elicitation or `-32042`?
5. What are the phishing/HMAC rules for URL-mode collect pages?
6. Is keyword matching on "spotify" acceptable for vault lookup?

### Questions investigated (review, fresh)

1. Does MCP forbid pre-authenticated collect URLs in the client/model context?
2. How do PostgreSQL and SQLite treat NULL in unique indexes (pending-need uniqueness)?
3. What does xAI document for custom MCP (elicitation, protocol version)?
4. How do grant magic links in this repo reach the operator versus the model?

### Questions investigated (review 2, fresh)

1. Does a generic `withTxn` around `createItem` actually transaction on node-pg?
2. Do SQLite partial unique indexes support `WHERE status = 'pending'`?
3. What does today's MCP/HTTP error mapper emit (string vs JSON body)?
4. Would rate-limiting all `http.request` calls starve legitimate connector use?

### Questions investigated (review 3, fresh)

1. Does MCP 2024-11-05 put tool business errors in `isError` result content (so the model sees `collect_url`) or in JSON-RPC `error.data`?
2. How should concurrent fulfill of one pending row be claimed (application SELECT vs `UPDATE … WHERE status = 'pending'`)?
3. Does `ON CONFLICT` against a partial unique index need the predicate repeated (so we should not use it for need reuse)?
4. Would injecting a **second** `OrgRateLimiter` into the kernel double-count `request_grant` misses (http.ts already calls `allow`)?

### Sources consulted

| Source | URL | Takeaway |
| ------ | --- | -------- |
| MCP elicitation spec 2025-11-25 | https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation | Form mode MUST NOT request secrets. URL MUST NOT be pre-authenticated. Server MUST verify who submits. |
| MCP elicitation (review re-read) | https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation | MUST NOT provide a URL which is pre-authenticated to access a protected resource (malicious client impersonation). |
| IMTI elicitation explainer | https://imti.co/mcp-elicitation/ | Phishing: attacker starts flow, victim completes, tokens bind to attacker. Mitigate by verifying submitter identity against the intended user. |
| WorkOS URL-mode elicitation | https://workos.com/blog/mcp-url-mode-elicitation | Client must advertise `elicitation.url`. Fallback required. Completion tracked by server. |
| Strands `-32042` issue | https://github.com/strands-agents/sdk-python/issues/1742 | Many clients stringify MCP errors and drop `error.data`. |
| xAI custom MCP connectors | https://docs.x.ai/grok/connectors | Custom connector: public URL + authentication. No elicitation, no protocol version, no `-32042`. |
| xAI MCP servers (Grok Build) | https://docs.x.ai/build/features/mcp-servers | HTTP + `--header Authorization`. OAuth browser flow for some servers. Not Bot Grok elicitation. |
| 1Password Environments MCP | https://www.1password.dev/environments/mcp-server | Names only. Desktop prompt. Local stdio. |
| Infisical Agent Proxy | https://infisical.com/docs/cli/commands/agent-proxy | Inject on outbound HTTPS, not into the agent env. |
| Infisical Agent Proxy blog | https://infisical.com/blog/agent-proxy | Matches our `http.request` connector. |
| PostgreSQL unique indexes | https://www.postgresql.org/docs/current/indexes-unique.html | Default: NULLs distinct. Multiple pending rows with `host NULL` would bypass uniqueness. |
| SQL unique NULL compatibility | https://www.caniusesql.com/f/unique-constraint | SQLite also treats NULLs as distinct. Use a non-null sentinel (`''`) for portable uniqueness. |
| secretless-ai | https://github.com/opena2a-org/secretless-ai/ | List names only; decrypt at spawn. |
| agent-tool-design (in-repo) | `.cursor/skills/agent-tool-design/SKILL.md` | Prefer `search_*`. Result `status` should steer the next call. |
| node-pg transactions | https://node-postgres.com/features/transactions | MUST use one `pool.connect()` client. `pool.query('BEGIN')` is not a transaction. |
| node-pg pool.query warning | https://node-postgres.com/apis/pool | Do not use `pool.query` inside a transaction. |
| SQLite partial indexes | https://sqlite.org/partialindex.html | `CREATE UNIQUE INDEX ... WHERE expr` is supported; uniqueness applies only to matching rows. |
| Live MCP catch | `src/hosted/mcp.ts` `callHostedMcpTool` | HttpError becomes `{ error: message }`. `collect_url` would be dropped. |
| Live HTTP sendError | `src/hosted/http.ts` | Same: `{ error: err.message }` only. |
| MCP 2024-11-05 tools | https://modelcontextprotocol.io/specification/2024-11-05/server/tools | Tool execution errors MUST be `result.isError: true` with details in `content`, not a JSON-RPC error (the LLM would not see `collect_url`). |
| MCP CallToolResult schema | https://github.com/modelcontextprotocol/specification/blob/main/schema/2024-11-05/schema.json | Same: errors from the tool SHOULD be inside the result object. |
| MCP elicitation (re-read) | https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation | MUST NOT provide a pre-authenticated URL. Path-only collect_url still holds. |
| Postgres INSERT ON CONFLICT | https://www.postgresql.org/docs/current/sql-insert.html | `ON CONFLICT` is atomic upsert. Partial unique indexes require the predicate in the conflict target. |
| QueryPlane ON CONFLICT + partial indexes | https://queryplane.com/blog/postgres-upsert/ | Repeat `WHERE` on the conflict target or Postgres cannot pick the partial index. Prefer INSERT + unique catch + SELECT for pending-need reuse. |
| Unique vs app-level check | https://www.distributedrequest.com/backend-implementation-storage-patterns/database-unique-constraints-upserts/postgresql-unique-constraints-vs-application-level-checks/ | Unique evaluated at commit; `UPDATE … WHERE status = 'pending'` is the claim. Zero rows → already fulfilled. |

### State of the art / common practice

- Names in the model, values in a broker.
- Out-of-band collect for secrets; URL is not a session cookie.
- Exact structured match in the vault; LLM maps "Spotify API" to `api.spotify.com`.

### Pitfalls & anti-patterns to avoid

- HMAC or session in `collect_url` given to the model (spec + grant-flow contradiction).
- Asking Grok to paste an API key.
- Form elicitation of passwords.
- Keyword lists for "which secret is Spotify".
- `get_secret` after collect.
- `-32042` as the only place the URL appears.
- Unique index on nullable `host` (duplicate pending needs).
- Fulfill as three separate commits (orphan item, grant without item).
- Unbounded `need_items` inserts from a stolen `avm_` token.

### Implications for this plan

| Practice | Verdict |
| -------- | ------- |
| MCP URL-mode elicitation RPC | **Reject** as a dependency. **Adapt** a path-only URL in tool JSON. |
| Pre-authenticated collect URL in MCP | **Reject** (review P0). Operator bearer on POST. |
| Form elicitation of the key | **Reject** |
| 1Password names-only | **Adopt** for `find_items` |
| Infisical / connector inject | **Adopt** (shipped) |
| NULL host in unique pending index | **Reject**. `host TEXT NOT NULL` |
| Changing grant HMAC token shape | **Reject** this change |
| Generic `withTxn` wrapping `createItem` | **Reject**. Use `persistFulfill` on one client. |
| Rate-limit every `http.request` | **Reject**. Limit `ensureNeedItem` only. |
| MCP miss as `fail(message)` | **Reject**. `NeedItemError.payload`. |
| JSON-RPC `error.data` as the only miss channel | **Reject**. MCP 2024-11-05: tool errors go in `isError` result content so the model can read `collect_url`. |
| Second `OrgRateLimiter` in HostedKernel | **Reject**. Pass the http.ts instance. Skip a second `allow` on `request_grant` miss. |
| `ON CONFLICT` on the partial pending index for reuse | **Reject** (predicate footgun). `insertPendingNeed`: INSERT, on unique SELECT existing. |
| Fulfill without `AND status = 'pending'` | **Reject**. AC-13 requires a claim. |

## 5. Requirements

### Functional (EARS)

- **R-01.** The hosted operator console SHALL let an authenticated operator store a secret or login item with name, kind, environment, value (password input), optional username, allowed hosts, and inject (`bearer` \| `basic` \| `header:<name>`).
- **R-02.** WHEN a model client calls `find_items` with `item_name` and/or `host`, the system SHALL return JSON with `status` `found` \| `ambiguous` \| `need_item` \| `host_mismatch` and SHALL NOT include item values, ciphertext, HMAC secrets, or `t=` query params.
- **R-03.** WHEN both `item_name` and `host` are provided, matching SHALL be AND: the named item must include that hostname on `allowed_hosts`. WHEN only name matches and host does not, `status` SHALL be `host_mismatch` with that item's public fields (including `allowed_hosts`); the system SHALL NOT insert a need.
- **R-04.** WHEN only `host` is provided and exactly one item allowlists it, `status` SHALL be `found`. WHEN 2–5 match, `ambiguous`. WHEN more than 5, first 5 by name A–Z and `truncated: true`.
- **R-05.** WHEN only `item_name` is provided and it exists, `status` SHALL be `found` (hosts listed so the agent can call `http.request` against an allowlisted origin).
- **R-06.** `find_items` SHALL require at least one of `item_name` or `host`. IF both are omitted, THEN the tool result SHALL be an error (`isError: true`), not a `list_items` dump.
- **R-07.** Matching SHALL be exact: `normalizeSecretName` for names; hostname lowercased, no wildcards, no IP literals (`assertAllowedHostname` shape). The system SHALL NOT classify task text with regex or keyword lists.
- **R-08.** WHEN `find_items` matches zero items (and R-03 does not apply), the system SHALL create or reuse a pending `need_item` and return `status: "need_item"`, `collect_url` equal to `{publicUrl}/collect/{needId}` with **no query string**, `suggested_name`, `host`, `client_name`, `message` telling the operator to open that Botpasses URL and sign in (never to paste the secret into chat). `isError` SHALL be true.
- **R-09.** WHEN MCP `request_grant`, MCP `http.request`, or REST `POST /api/grants/request` sees an unknown `item_name`, the system SHALL behave as R-08 (same need reuse rules). `http.request` SHALL NOT return a connector `{ status, body }` pair for this case.
- **R-10.** WHEN the operator POSTs fulfill with a non-empty value, at least one allowed host, and operator bearer, the system SHALL persist item + prompt grant + need update via `store.persistFulfill` on one connection. IF standing policy exists, the grant SHALL be active immediately (existing `requestGrant` rule).
- **R-11.** Model (`avm_`) and trusted (`avt_`) principals SHALL NOT `POST /api/items` or fulfill a need.
- **R-12.** `GET /collect/:id` HTML SHALL include a password input, the requesting client **name**, suggested name, host, and task description, and SHALL NOT include any item value. After submit, the value field is cleared.
- **R-13.** Hosted `http.request` SHALL attach the credential only inside the vault process and return a redacted body. MCP SHALL remain without `get_secret`.
- **R-14.** Local stdio MCP SHALL, on unknown secret name, return `status: "need_item"` with a store-via-CLI message and SHALL NOT include `collect_url`.
- **R-15.** WHILE a need is `pending` and not expired, a second find with the same client/env/name/host SHALL reuse the same `need_id` and `collect_url`. Expired pending rows SHALL be `cancelled` then a new row inserted.
- **R-16.** WHEN `ensureNeedItem` would insert or reuse a pending need, the system SHALL call `OrgRateLimiter.allow(orgId)` and IF it returns false, THEN throw 429 and SHALL NOT insert. Successful `http.request` SHALL NOT use this limiter.
- **R-17.** WHEN `deleteOrg` runs, the system SHALL delete that org's `need_items` inside the existing org-delete transaction.
- **R-18.** WHEN MCP or REST handles a need-item miss, the tool/HTTP body SHALL be `NeedItemError.payload` (includes `collect_url`). The system SHALL NOT reduce the miss to `{ error: "Unknown item" }`.
- **R-19.** `GET /collect/:id` SHALL be served as HTML from `route()` (same as `/`). The system SHALL NOT expose unauthenticated `GET /api/need-items/:id` JSON.
- **R-20.** `persistFulfill` SHALL `UPDATE need_items SET status = 'fulfilled', … WHERE id = $1 AND status = 'pending'`. IF that update affects 0 rows, THEN the transaction SHALL ROLLBACK and the kernel SHALL throw 409. Unique `(environment_id, name)` on items remains the second race backstop.
- **R-21.** `insertPendingNeed` SHALL INSERT the pending row. IF the partial unique index rejects it (Postgres `23505` / SQLite constraint), THEN SELECT the existing pending row for that key and return it. The kernel SHALL NOT parse driver error strings.
- **R-22.** `ensureNeedItem` SHALL call `limiter.allow(orgId)` unless the caller passes `alreadyLimited: true`. `requestGrant` miss SHALL pass `alreadyLimited: true` because `http.ts` already counted that `request_grant`. `find_items` and `http.request` miss SHALL NOT pass it. The limiter instance SHALL be the one constructed in `createHostedServer`.
- **R-23.** WHEN `find_items` returns `status` `need_item` or `host_mismatch`, MCP `isError` SHALL be true and `content[0].text` SHALL be `JSON.stringify` of that object (not `{ error: <message> }`). `found` and `ambiguous` SHALL use `isError` false / omitted.

### Non-functional

- **N-01.** No new runtime dependencies.
- **N-02.** Schema expand-only: `CREATE TABLE IF NOT EXISTS need_items` plus unique partial index on pending rows. Reversible: `DROP TABLE IF EXISTS need_items`.
- **N-03.** Need row `expires_at` is now + 15 minutes (`MAGIC_TTL_MS`). Reuse refreshes `expires_at` on the existing pending row.
- **N-04.** `assertSafePublicObject` on every MCP/REST **response** in this flow. Do not name response keys `token` or `value`. The fulfill **request** body field for the secret is `value` (operator POST only; never echoed).
- **N-05.** Gate: `npm test && npm run typecheck`.
- **N-06.** Fulfill uses `persistFulfill` on one postgres `PoolClient` / one sqlite `BEGIN`. No `pool.query('BEGIN')`. No compensate-by-delete fork.
- **N-07.** `task_description` stored on a need is truncated to 500 characters (existing `BODY_CAP` is 128KiB; do not persist the whole body).

### Acceptance criteria (Given/When/Then)

- **AC-01.** Given an empty staging vault and model MCP, when the agent calls `find_items` with `host: "api.spotify.com"`, then the result JSON has `status: "need_item"`, `collect_url` starting with `VAULT_PUBLIC_URL`, `collect_url` contains no `?`, and the canary is absent.
- **AC-02.** Given the operator signs in and POSTs fulfill with `CANARY` as `SPOTIFY_TOKEN` host `api.spotify.com` inject `bearer`, when the agent calls `find_items` with the same host, then `status` is `found`, `item_name` is `SPOTIFY_TOKEN`, and `CANARY` is absent.
- **AC-03.** Given two items both allowlisting `api.example.com`, when `find_items` is called with that host, then `status` is `ambiguous`, `items.length` is 2, hosts are present, and neither value appears.
- **AC-04.** Given `find_items` with neither name nor host, when called, then `isError` is true and the payload is not a full item dump.
- **AC-05.** Given a pending need, when `find_items` is repeated, then `need_id` is unchanged.
- **AC-06.** Given a pending need, when a model bearer POSTs `/api/need-items/:id/fulfill`, then the status is 401 or 403 and no item is created.
- **AC-07.** Given a fulfilled need and an active prompt grant, when `http.request` GET hits the allowlisted origin, then the mock origin sees `Authorization: Bearer CANARY` and the MCP body does not contain `CANARY`.
- **AC-08.** Given `request_grant` with unknown name `NEW_KEY`, when called, then the payload includes `collect_url` (not only `"Unknown item"`) and `isError` is true.
- **AC-09.** Given collect HTML fetch, when the need is pending, then the document contains a password input, the client name, and does not contain any stored secret.
- **AC-10.** Given local MCP `request_grant` for a missing name, when called, then `status` is `need_item` and `collect_url` is absent.
- **AC-11.** Given item `FOO` allowlisting only `api.foo.com`, when `find_items` is called with `item_name: "FOO"` and `host: "api.bar.com"`, then `status` is `host_mismatch`, no new need row exists, and values are absent.
- **AC-12.** Given `collect_url` from MCP, when parsed as a URL, then `search` is empty.
- **AC-13.** Given two concurrent fulfill POSTs for one need, when both commit, then one succeeds and the other is 409, and at most one item exists with that name.
- **AC-14.** Given `http.request` with unknown `item_name`, when called, then the result is `need_item` JSON (`isError` true), not `{ status: <http>, body: ... }`.
- **AC-15.** Given REST `POST /api/grants/request` with unknown `item_name`, when called, then the HTTP status is 404 and `JSON.parse(body).collect_url` is a string (not only `{ error: "Unknown item" }`).
- **AC-16.** Given `find_items` with `host` that matches zero items, when the MCP result is parsed, then `isError` is true and `JSON.parse(content[0].text).status` is `"need_item"` (not `{ error: "Unknown item" }`).
- **AC-17.** Given a pending need, when two `insertPendingNeed` calls race, then both return the same `need_id` and only one row is pending.

### Edge cases & error paths

- Invalid `item_name`: 400 `normalizeSecretName` message; no need.
- Invalid host (IP, wildcard, blocked): 400; no need.
- Duplicate item name on fulfill: 409; need stays pending; page shows the conflict.
- Empty value on fulfill: 400.
- Unauthenticated GET collect: 200 HTML, no values.
- Unauthenticated POST fulfill: 401.
- Production client cannot create staging items (existing env isolation).
- Inbox needs include `task_description` and client name, no values.
- Rate limit exceeded: 429, no new need.

## 6. Design decisions (mini-ADRs)

### D-01: How the operator is prompted to enter a missing key

- **Context:** Agent cannot find an item. Secret must not enter Grok/Claude.
- **Options:** (A) MCP form elicitation of the password. (B) MCP URL elicitation / `-32042` only. (C) Path-only `collect_url` in tool JSON + inbox + operator session on POST. (D) HMAC on `collect_url` in MCP (draft). (E) Email only.
- **Decision:** C. Reject D (spec + live grant split). E is a Non-goal.
- **Informed by:** MCP MUST NOT pre-authenticate URLs; IMTI phishing write-up; `approval_code` vs `/approve?token=` in this repo; xAI connector docs.
- **Consequences:** Operator must sign in on Botpasses (bootstrap token on the collect page, same `sessionStorage` key as `/`). Model seeing a URL is not seeing a capability.

### D-02: How agents find the right key

- **Context:** Ambiguity and misses.
- **Options:** (A) Regex/keywords. (B) Vault LLM. (C) Structured `find_items` exact match, cap 5. (D) Always dump `list_items`.
- **Decision:** C. Keep `list_items` for inventory. `find_items` returns `allowed_hosts` (list_items MCP today does not).
- **Informed by:** `no-regex-for-semantics`; agent-tool-design; live `mcp.ts` mapping gap.
- **Consequences:** Agent must pass `api.spotify.com` not `spotify.com` unless stored. Store-form help states the API hostname.

### D-03: Inject without the agent seeing the key

- **Options:** (A) `http.request` (current). (B) MITM proxy. (C) Secret in MCP. (D) `vault run` local.
- **Decision:** A hosted, D local. Reject B and C.
- **Informed by:** Infisical Agent Proxy; `connector.ts`; AGENTS.md.
- **Consequences:** MCP instructions: find → (operator collect if needed) → `http.request`. Never "use the key in reasoning."

### D-04: Collect completion vs grant policy

- **Options:** (A) Store only. (B) Store + prompt grant for that client. (C) Store + standing.
- **Decision:** B. Collect page shows **client name** so the operator sees who will receive the prompt grant.
- **Informed by:** Existing standing short-circuit; IMTI confused-deputy (wrong client binds the credential).
- **Consequences:** First `http.request` consumes the prompt grant. Agent may `request_grant` again for a second call.

### D-05: Collect auth (retracted HMAC)

- **Context:** Draft used HMAC on `collect_url`. Grant HMAC is email-only.
- **Options:** (A) HMAC in MCP URL. (B) Operator bearer on fulfill, path-only URL in MCP. (C) Change `mintApprovalToken` to `{ kind, id, exp }`.
- **Decision:** B. Reject A and C for this change.
- **Informed by:** MCP pre-auth ban; live `requestGrant` return shape.
- **Consequences:** Collect page includes the same token sign-in field as `/`. Inbox "Open collect" is same-origin, already operator-authed, still POSTs with bearer.

### D-06: Suggested name when only host is provided

- **Options:** (A) Require `item_name`. (B) Derive `API_SPOTIFY_COM` from hostname (dots to underscores, uppercase) then `normalizeSecretName`. (C) Blank name.
- **Decision:** B as default; operator may edit. Agent-supplied valid `item_name` wins.
- **Informed by:** Structural transform of a structured field, not semantic classification.
- **Consequences:** Name collision is 409; operator edits the name.

### D-07: Name and host together

- **Decision:** AND match. Else `host_mismatch`, no need row.
- **Informed by:** Creating a second item with the same semantic purpose would 409 on the same name anyway.
- **Consequences:** Operator adds a host on the existing item (out of this change except 409 copy) or picks another `item_name`.

### D-08: Fulfill atomicity

- **Context:** Draft said `VaultStore.withTxn(fn)` wrapping `createItem`. `createItem` uses `store.insertItem` → postgres `#pool.query`.
- **Options:** (A) Generic withTxn + ALS so all store methods see the client. (B) `persistFulfill` one method, one client (copy `deleteOrg`). (C) Three separate commits plus compensate-delete.
- **Decision:** B. Reject A (extra ALS complexity, easy to miss a method). Reject C.
- **Informed by:** https://node-postgres.com/features/transactions ; https://node-postgres.com/apis/pool ; live `PostgresStore.deleteOrg`.
- **Consequences:** Kernel builds encrypted `ItemRecord` + `HostedGrantRecord` + need patch, then one store call. Console `createItem` stays a single insert. SQLite uses `BEGIN` on `DatabaseSync` like `deleteOrg` (same connection, so it is actually atomic). The need UPDATE is `WHERE status = 'pending'` (D-10).

### D-09: Rate limiter instance and double-count

- **Context:** `createHostedServer` already `allow()`s MCP and REST `request_grant`. A new limiter inside `HostedKernel` would make a miss consume two slots and would not share the 30/hour budget with successful grants.
- **Options:** (A) Second limiter in kernel. (B) Same instance; `ensureNeedItem` always `allow`. (C) Same instance; `alreadyLimited` on `requestGrant` miss; `find_items` / `http.request` miss count in `ensureNeedItem`.
- **Decision:** C.
- **Informed by:** live `src/hosted/http.ts` lines 144–146 and 283–286; `MAX_PER_WINDOW` 30 in `rate-limit.ts`.
- **Consequences:** Tests construct one limiter, pass it to both server and kernel (or only kernel if tests call kernel directly).

### D-10: Claiming a pending need under concurrency

- **Context:** Two fulfill POSTs, or two `insertPendingNeed` races.
- **Options:** (A) SELECT then UPDATE (TOCTOU). (B) `UPDATE … WHERE status = 'pending'` + unique item name. (C) `ON CONFLICT` on the partial pending index for insert reuse.
- **Decision:** B for fulfill. For insert reuse: INSERT then on unique SELECT (not ON CONFLICT, because the arbiter is a partial index).
- **Informed by:** Postgres INSERT docs; QueryPlane partial-index ON CONFLICT predicate; unique-vs-app-check article.
- **Consequences:** AC-13 and AC-17.

## 7. Technical design

### Architecture / data flow

```
Agent: find_items({ host: "api.spotify.com" })
  → 0 matches → insert need_items (pending), rate-limited
  → MCP isError true, JSON { status: need_item, collect_url, suggested_name, host, client_name, message }
  → model quotes collect_url; operator also sees inbox

Operator: GET /collect/nid_…  (no query HMAC)
  → signs in with bootstrap token (sessionStorage, same key as /)
  → POST /api/need-items/:id/fulfill Authorization Bearer
  → persistFulfill: item + prompt grant + need fulfilled

Agent: find_items (found) or list_grants then http.request
  → connector attaches Bearer, redacts body
```

Suggested name from host: split on `.`, join `_`, uppercase, `normalizeSecretName`. If that throws, collect page requires a typed name (empty default).

### Data model & migrations

Table `need_items` in `HOSTED_SCHEMA_SQLITE` and `migrations/002_need_items.sql`:

| Column | Type | Notes |
| ------ | ---- | ----- |
| id | TEXT PK | `nid_` + UUID |
| org_id | TEXT | |
| client_id | TEXT | requesting model client |
| environment_id | TEXT | |
| suggested_name | TEXT | env-var shape |
| host | TEXT NOT NULL | lowercase hostname or `''` |
| task_description | TEXT NULL | |
| status | TEXT | `pending` \| `fulfilled` \| `cancelled` |
| item_id | TEXT NULL | |
| grant_id | TEXT NULL | |
| expires_at | TEXT | now + 15m |
| created_at | TEXT | |
| fulfilled_at | TEXT NULL | |

```sql
CREATE UNIQUE INDEX IF NOT EXISTS need_items_pending
  ON need_items (org_id, client_id, environment_id, suggested_name, host)
  WHERE status = 'pending';
```

No ciphertext on this table.

`PostgresStore.migrate()` / sqlite exec already run `HOSTED_SCHEMA_SQLITE`. Expand-only.

`deleteOrg` (postgres + sqlite): `DELETE FROM need_items WHERE org_id = $1` inside the existing BEGIN, **before** deleting clients.

`VaultStore.persistFulfill(input): Promise<void>` — one postgres `connect()` client: INSERT item, INSERT grant, `UPDATE need_items SET status='fulfilled', item_id, grant_id, fulfilled_at WHERE id=$1 AND status='pending'`, INSERT audit; if update rowCount is 0, ROLLBACK and throw; else COMMIT. SQLite: `BEGIN` / same writes / `COMMIT`. Unique violations surface as 409.

`VaultStore.insertPendingNeed(row): Promise<NeedItemRecord>` — INSERT; on unique conflict SELECT pending by the unique key and return that row.

Down: `DROP TABLE IF EXISTS need_items`.

### APIs / jobs / UI surfaces

- **MCP (hosted)**

- Add `find_items` to `HOSTED_MCP_TOOL_NAMES`. Args: `item_name` optional, `host` optional, `task_description` optional. `additionalProperties: false`.
- Helper `mcpPayloadResult(payload)`: `content: [{ type: "text", text: JSON.stringify(payload) }]`, `isError` true iff `payload.status` is `need_item` or `host_mismatch`, or the thrown error is `NeedItemError`. Do **not** use `fail(message)` for these.
- Unknown `request_grant` / `http.request`: throw `NeedItemError` with payload. `callHostedMcpTool` serializes `payload` with `isError: true`.
- `MCP_INSTRUCTIONS_HOSTED`: find → collect on Botpasses if needed → grant/http.request; never paste secrets.
- `HostedKernel` constructor takes the **same** `OrgRateLimiter` instance as `createHostedServer`. `ensureNeedItem` calls `allow` unless `alreadyLimited`.

**REST**

- `GET /api/inbox` adds `needs[]` (operator). collect_path `/collect/:id` only.
- `GET /collect/:id` HTML in `route()` next to `/` (after `originOk` + `auth()`, no `requireOperator`). Server-render from `getNeed`. Unknown id: 404 HTML without leaking other orgs.
- `POST /api/need-items/:id/fulfill` `requireOperator`. Body (same field names as `POST /api/items` where they overlap): `value` (required), `name` (optional, default need.suggested_name), `allowed_hosts` (required, ≥1), `inject` (default `bearer`), `kind` (default `secret`), `username` (required if kind is `login`). Do not accept `client_id` or `environment` from the body (A-13).
- Response: `{ item: ItemPublic, grant_status: string }` with no `value` key.
- `POST /api/grants/request` unknown: `sendError` emits `NeedItemError.payload` at 404.
- `sendError`: if `NeedItemError`, `JSON.stringify(err.payload)` not `{ error: message }`.

**UI**

- Collect page: sign-in + one form; client name prominent; password value; prefilled name/host/inject; origin copy (Botpasses).
- Console store form: inject select; host field example `api.spotify.com`.
- Inbox: pending needs with Open collect (`/collect/:id`).

**Local MCP**

- Unknown `request_grant`: `{ status: "need_item", message: "..." }` no URL.

### Failure modes & retries / idempotency

- Re-find while pending and unexpired: same need; refresh `expires_at`.
- Expired pending: cancel, insert new id (new collect_url).
- Connector failure after grant: existing errors; value not in MCP.
- Fulfill: `persistFulfill` only. No compensate fork.
- 429: no insert.

### Feature flags / env (if any)

- None. `VAULT_PUBLIC_URL`, `VAULT_BOOTSTRAP_TOKEN`. `VAULT_APPROVAL_HMAC` unchanged (grants only).

### Security, privacy, tenancy notes

- `collect_url` is not a capability. POST needs operator bearer.
- Collect page shows which **client** asked (confused-deputy).
- `assertSafePublicObject`: `collect_url` not `token`.
- Audit: `need_created`, `need_fulfilled` with item name only.
- `originOk` on collect routes.
- Stolen `avm_`: can create needs (rate limited), cannot fulfill, cannot store.

## 8. Implementation tasks

### T-01: Schema, store, org delete, persistFulfill

- Depends on: none
- Touch: `src/store/schema.ts`, `src/store/types.ts`, `src/store/sqlite-hosted.ts`, `src/store/postgres.ts`, `src/hosted-types.ts`, `migrations/002_need_items.sql`
- Do: `need_items` table; unique pending index; `insertPendingNeed`; `persistFulfill` with pending claim; `deleteOrg` deletes needs
- Acceptance: insert/get pending need; unique pending reuse (AC-17); deleteOrg removes needs; persistFulfill rolls back if grant insert fails (pre-insert a grant with the same id); persistFulfill 409 when need already fulfilled (second UPDATE rowCount 0)
- Verify: `test/need-items.test.ts` (store section)

### T-02: Kernel find + need + fulfill

- Depends on: T-01
- Touch: `src/hosted/kernel.ts`, `src/ids.ts` (`suggestedNameFromHost`), `src/hosted/errors.ts` (`NeedItemError`)
- Do: `findItems`, `ensureNeedItem` (cancel expired, rate limit with `alreadyLimited`), `fulfillNeed` → `persistFulfill`; do not change `mintApprovalToken`
- Acceptance: AC-01–AC-05, AC-08, AC-11–AC-13, AC-17 at kernel
- Verify: `test/need-items.test.ts`

### T-03: MCP + HTTP surfaces

- Depends on: T-02
- Touch: `src/hosted/mcp.ts`, `src/hosted/http.ts`, `src/brand.ts`, `src/mcp.ts`
- Do: `find_items` on `HOSTED_MCP_TOOL_NAMES`; `mcpPayloadResult`; NeedItemError through MCP and `sendError`; inbox `needs`; collect GET HTML in `route()` next to `/`; fulfill POST body per A-13; pass http.ts limiter into kernel
- Acceptance: AC-04, AC-06, AC-10, AC-12, AC-14–AC-16
- Verify: `test/hosted-mcp-find.test.ts`, `test/machine-tokens.test.ts`

### T-04: Collect page + console UX

- Depends on: T-03
- Touch: `src/hosted/collect-page.ts` (preferred split) + `src/hosted/operator-page.ts` + http GET
- Do: collect HTML with sign-in + client name; inbox links; store form inject select + host help
- Acceptance: AC-09
- Verify: HTML fetch asserts password input, client name, canary absent

### T-05: Isolation + connector regression

- Depends on: T-03, T-04
- Touch: `test/isolation.test.ts`
- Do: hosted find → operator fulfill → `http.request`; canary never in transcript; mock origin received bearer. Regression: current unknown `requestGrant` is 404 message-only (fails this test before the kernel change; passes after). Inverse: unique host match does not insert a need.
- Acceptance: AC-07
- Verify: `npm test` including isolation

### T-06: Docs

- Depends on: T-03
- Touch: `README.md`, `CHANGELOG.md` (0.3.2)
- Do: find_items → collect (sign in on Botpasses) → http.request; never paste secrets in chat
- Acceptance: grep README for `find_items` and `collect_url`
- Verify: changelog entry user-visible

## 8b. Task topology

- Choice: **single-loop**
- Escalation test 1: **FAIL** — kernel, store, mcp, http, HTML share `NeedItemRecord`.
- Escalation test 2: **FAIL** — MCP tests need kernel+store.
- Task file: `.loadout/tasks/key-discovery-and-store-prompt/TASK.md`
- Units: single-loop: no units
- Merge order: N/A
- Isolation: **shared-trunk**
- Concurrency: 1

## 9. Test plan

- `test/need-items.test.ts`, `test/hosted-mcp-find.test.ts`, isolation canary, machine-token cannot fulfill, collect HTML, local MCP miss, REST 404 body has `collect_url`, unique pending with `host ''`, deleteOrg cascade, rate limit, AC-16 MCP isError JSON, AC-17 insert race.
- Regression: unknown `request_grant` MCP result must include `collect_url` (fails on unfixed 404 string). Inverse: exact unique match is `found` with no need row.
- Gate: `npm test && npm run typecheck`
- Manual: staging Grok Bot `find_items` for a missing host, open `collect_url` in a browser, sign in, store a **non-production** dummy, then `http.request`. Do not paste real third-party secrets into chat.

## 10. Rollout & rollback

- Ship: land on `dev` when asked. Neon migrate is `CREATE TABLE IF NOT EXISTS` at boot.
- Rollback: revert the deploy. Orphan `need_items` are harmless. Items created on collect remain. Grant HMAC format unchanged.
- Monitoring: audit `need_created` / `need_fulfilled`; `/ready` unchanged.

## 11. Risk register

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Grok never surfaces tool JSON | Medium | Operator never sees URL | Inbox; MCP message tells the agent to quote `collect_url` |
| Operator pastes secret into Grok | Medium | Transcript leak | Instructions; cannot stop a determined user |
| Phishing collect URL | Low | Stolen key typed on fake origin | Path-only URL; sign-in; address-bar copy; `originOk` |
| Operator fulfills for the wrong client | Medium | Credential bound to attacker client | Client name on collect page and inbox |
| HMAC in MCP (draft) | High if shipped | Capability in transcript | Retracted; AC-12 |
| Duplicate pending needs with NULL host | High if shipped | Broken idempotency | `host NOT NULL` |
| Partial fulfill | Medium | Orphan items | `persistFulfill` on one client |
| Stolen `avm_` floods needs | Medium | Table growth | Org rate limiter |
| Derived name 409 | Medium | Stuck need | Operator edits name |

## 12. Definition of done

- [ ] All ACs pass
- [ ] `npm test && npm run typecheck` green with output pasted
- [ ] README + changelog + MCP instructions in the same change
- [ ] No stubs, no `get_secret`, no form elicitation of values, no HMAC on `collect_url`
- [ ] External research recorded and reflected in D-01–D-10
- [ ] Edits left unstaged unless the user asks to commit

## Pre-mortem (review)

1. **Capability leak:** HMAC `collect_url` in Grok logs lets anyone plant a fake token. Mitigation: path-only URL, operator POST (D-05, AC-12).
2. **Wrong client:** Attacker bot creates a need; operator stores a real key. Mitigation: client name on the page (D-04, R-12).
3. **NULL unique miss:** Two pending needs for the same name. Mitigation: `host TEXT NOT NULL` (D-07 schema, Postgres docs).
4. **Orphan item:** Grant insert fails after item insert. Mitigation: `persistFulfill` (D-08).
6. **Silent miss JSON:** MCP `{ error: "Unknown item" }` without URL. Mitigation: NeedItemError payload (R-18, AC-08, AC-15).
7. **Fake txn:** persistFulfill on pool.query. Mitigation: D-08 B.
8. **Double fulfill:** Two POSTs both insert items. Mitigation: D-10 claim + unique item name (AC-13).
9. **fail(message) on find_items:** Model sees `{ error: … }` without `collect_url`. Mitigation: R-23, AC-16.

## Review changelog

- P0: Removed HMAC from MCP `collect_url`. Fulfill is operator bearer only. Aligns with grant `approval_code` vs email magic and MCP pre-auth ban.
- P0: Collect page and inbox show requesting client name (confused-deputy).
- P1: `host TEXT NOT NULL` (`''` when unnamed host) + partial unique index; cancel expired pending before insert.
- P1: `persistFulfill` on one client for fulfill; no compensate fork.
- P1: AND match + `host_mismatch`; `find_items` returns `allowed_hosts`.
- P1: REST `POST /api/grants/request` miss returns 404 JSON with `collect_url`; MCP miss uses `isError: true`.
- P1: Rate-limit need creation; `deleteOrg` deletes `need_items`.
- P1: Do not change `mintApprovalToken` JSON.
- P2: Split collect HTML into `collect-page.ts`; `isError` true only for blocking statuses.
- Retracted draft D-05 HMAC `kind` field.
- Fresh sources: MCP pre-auth MUST NOT, IMTI phishing, PG unique NULL, xAI connectors (no elicitation).
- CreatePlan / Build UI: `~/.cursor/plans/key_discovery_collect_65504298.plan.md` (created after first review).

## Review changelog (pass 2)

- P0: Replaced generic `withTxn`/`createItem` with `persistFulfill` on one pg client. `pool.query('BEGIN')` is not a transaction (node-pg docs).
- P0: `NeedItemError.payload` must flow through MCP catch and `sendError`. Live code would drop `collect_url` into `{ error: "Unknown item" }`.
- P1: Rate-limit inside `ensureNeedItem`, not all `http.request`.
- P1: Collect HTML server-rendered in `route()`; no public need JSON GET.
- P1: Fulfill requires ≥1 host. AC-15 for REST body.
- SQLite partial unique indexes confirmed (sqlite.org/partialindex.html).

## Review changelog (pass 3)

- P1: `persistFulfill` claims with `UPDATE … WHERE status = 'pending'` (0 rows → 409). Unique item name is the second backstop, not the only one.
- P1: `insertPendingNeed` INSERT then unique-conflict SELECT (no `ON CONFLICT` on the partial index).
- P1: Pass the existing http.ts `OrgRateLimiter` into the kernel. `requestGrant` miss uses `alreadyLimited: true`.
- P1: `mcpPayloadResult` so `find_items` `need_item` / `host_mismatch` keep full JSON + `isError: true`. Live `fail(message)` would drop fields.
- P1: Fulfill body locked (A-13): env/client from need row; `value`/`name`/`allowed_hosts`/`inject`/`kind`/`username` from POST.
- P2: Truncate `task_description` to 500 chars.
- Fresh sources: MCP 2024-11-05 tools `isError` in result; Postgres INSERT ON CONFLICT; QueryPlane partial-index conflict target; unique-constraint vs app check.

## Self-critique

Review replaced the draft HMAC collect path after checking live `requestGrant` (HMAC is email-only) and MCP URL-mode rules. Uniqueness, transactions, rate limits, `http.request` miss shape, concurrent claim, and MCP `fail(message)` were unspecified forks; they are now locked.
