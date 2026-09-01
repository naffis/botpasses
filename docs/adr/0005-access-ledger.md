# 0005. Access snapshot and issuance ledger

- Status: accepted
- Date: 2026-08-31

## Context

Local `vault serve` lists grants and revoke. The hosted console issued Grok tokens and approved inbox items but could not list who still holds a Bearer or revoke a client.

## Decision

One Access panel on `/console`. `GET /api/access` is the live snapshot (operators, clients, grants, sessions). `GET /api/access/events` is the issuance ledger (limit 200). Display kind is `oauth` when `oauth_client_id` is set; stored `ClientKind` stays `model` | `trusted`.

Revoke client sets `revoked_at`, destroys refresh/opaque adapter rows, revokes open grants, marks matching `access_events`. Current-session revoke is 400. Cross-org ids are 404. Bootstrap token is not a row.

## Consequences

- Store: `listMembers`, `listOperatorSessions`, `access_events` with unique `jti_hash`, 60s `last_seen` throttle.
- Console HTML: `data-testid="access-panel"` and `access-revoke-confirm`.

## Alternatives considered

- Grant-only revoke. Leaves OAuth and `avm_` bearers invisible.
- Redis `jti` denylist. Extra infra; Neon already holds `access_events`.
- TTL-only revoke. Breaks the immediate-revoke promise.
