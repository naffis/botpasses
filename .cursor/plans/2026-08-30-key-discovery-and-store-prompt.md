# Plan: Key discovery, operator collect, inject without visibility

Full research (EARS, ACs AC-01–AC-15, ADRs, citations): [docs/plans/2026-08-30-key-discovery-and-store-prompt.md](docs/plans/2026-08-30-key-discovery-and-store-prompt.md)

Task file: [`.loadout/tasks/key-discovery-and-store-prompt/TASK.md`](../../.loadout/tasks/key-discovery-and-store-prompt/TASK.md)

**Build:** [~/.cursor/plans/key_discovery_collect_65504298.plan.md](file:///Users/naffis/.cursor/plans/key_discovery_collect_65504298.plan.md)

Reviewed three times 2026-08-30. HMAC-on-`collect_url` from the draft is **retracted**. Generic `withTxn` around `createItem` is **retracted**. Pass 3 locked CAS fulfill, insertPendingNeed, shared limiter, mcpPayloadResult.

## 1. Summary

- Problem: Agents cannot find the right named credential; a miss is a dead 404; no secure collect page.
- Outcome: `find_items` returns found / ambiguous / host_mismatch / need_item. `collect_url` is path-only. Operator signs in on Botpasses and types the secret. `http.request` injects; MCP never returns the value.
- Approach: Exact name and/or exact hostname. No keyword matching. No HMAC in MCP (same split as grant `approval_code` vs email `/approve?token=`). Keep MCP `2024-11-05`. No new deps. No `get_secret`. Do not change grant HMAC JSON.

## 2. Scope

### In scope

Hosted find/collect/inbox, MCP+REST miss path, prompt grant on fulfill inside `persistFulfill` (pending claim), client name on collect page, shared OrgRateLimiter, deleteOrg cascade, console store-form polish, isolation tests, docs/changelog. Local MCP miss: message only, no URL.

### Non-goals (with rationale)

Form elicitation of secrets. Protocol bump. `-32042` as the only signal. HMAC on collect URL. Email collect links. Spotify OAuth. MITM proxy. Vault LLM matcher. Clerk on collect. Changing `mintApprovalToken`.

### Assumptions

A-1 xAI custom MCP docs: URL + auth, no elicitation. A-2 Operator pastes a Botpasses item (Spotify: Web API token, `api.spotify.com`, bearer). A-3 One pending need per client/env/name/`host` with `host` never NULL (`''` if name-only). A-4 Collect creates a prompt grant. A-5 `collect_url` has no query string. A-6 GET collect is public HTML; POST is operator bearer. A-7 Existing `originOk`. A-8 NeedItemError.payload. A-9 Fulfill ≥1 host. A-10 Collect GET next to `/` after auth() (undefined principal OK). A-11 Same limiter instance. A-12 mcpPayloadResult not fail(message). A-13 Fulfill env/client from need row.

### Open questions

None.

## 3. Current state

Store form exists. MCP `list_items` omits hosts. `requestGrant` 404. Grant HMAC is email-only. Inject is `connector.ts`. Isolation tests ban canaries.

## 4. External research

MCP 2025-11-25: MUST NOT pre-authenticate collect URLs. 1Password: names only. Infisical: inject on the wire. PG/SQLite: NULL ≠ NULL in unique indexes. xAI connectors: no elicitation. Live repo: do not put HMAC on MCP.

Citations: research doc §4 (includes review-pass sources).

## 5. Requirements

R-01 store UI. R-02–R-09 find + need_item (path-only URL, `isError` true on miss). R-03 AND match / host_mismatch. R-10 fulfill `persistFulfill`. R-11 model cannot fulfill. R-12 collect HTML + client name. R-13 connector inject. R-14 local miss. R-15 idempotent pending / cancel expired. R-16–R-22 limiter, deleteOrg, payload, collect HTML, CAS claim, insertPendingNeed, alreadyLimited. R-23 find_items isError JSON.

ACs AC-01–AC-17 in the research doc.

## 6. Design decisions

D-01 path-only collect_url + operator POST. D-02 structured find + hosts in result. D-03 keep `http.request`. D-04 prompt grant + show client name. D-05 no HMAC on collect (retracted draft). D-06 suggested name from hostname. D-07 AND / host_mismatch. D-08 `persistFulfill` on one pg client (not withTxn+createItem). D-09 same limiter + alreadyLimited. D-10 pending claim + insertPendingNeed. NeedItemError.payload through MCP and sendError. mcpPayloadResult for find_items.

## 7. Technical design

`need_items` with `host TEXT NOT NULL`. Unique pending index. MCP `find_items`. `GET /collect/:id`. `POST /api/need-items/:id/fulfill` `requireOperator`. REST grant miss: 404 JSON with `collect_url`. Inbox `needs[]`.

## 8. Implementation tasks

T-01 schema/store/persistFulfill/deleteOrg. T-02 kernel + NeedItemError. T-03 MCP+HTTP sendError payload. T-04 collect/console HTML. T-05 isolation tests. T-06 README+changelog.

## 8b. Task topology

single-loop. Escalation tests FAIL. Isolation: shared-trunk. Concurrency: 1.

## 9. Test plan

`test/need-items.test.ts`, isolation canary, machine-token cannot fulfill, AC-12 no query string. Gate: `npm test && npm run typecheck`.

## 10. Rollout & rollback

Staging boot `CREATE TABLE IF NOT EXISTS`. Revert deploy. Grant HMAC format unchanged.

## 11. Risk register

Grok hides JSON → inbox. Wrong client → show client name. Stolen avm_ → rate limit. Draft HMAC leak → retracted.

## 12. Definition of done

ACs + gate + docs in the same change. Unstaged until asked to commit.

## Review changelog

See research doc. Pass 2 P0: persistFulfill one client; NeedItemError through sendError/MCP. Pass 3 P1: CAS fulfill, insertPendingNeed, shared limiter, mcpPayloadResult, fulfill body A-13. ACs through AC-17.
