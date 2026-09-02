import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clientUsage,
  fetchedNames,
  grantUsage,
  maxIso,
  minIso,
  sessionUsage,
} from "../src/hosted/access-usage.ts";
import type { AccessEventRecord, HostedAuditRecord } from "../src/hosted-types.ts";

function audit(
  action: string,
  at: string,
  itemName: string | null,
  clientId: string | null,
): HostedAuditRecord {
  return { id: `aud_${at}`, orgId: "org", action, actor: "a", itemName, clientId, at };
}

function event(clientId: string, issuedAt: string): AccessEventRecord {
  return {
    id: `aev_${issuedAt}`,
    orgId: "org",
    clientId,
    actorUserId: null,
    kind: "machine",
    jtiHash: "h",
    issuedAt,
    expiresAt: null,
    revokedAt: null,
  };
}

test("minIso and maxIso ignore nulls and pick ISO order", () => {
  assert.equal(minIso([null, "2026-09-01T12:00:00.000Z", "2026-08-01T12:00:00.000Z"]), "2026-08-01T12:00:00.000Z");
  assert.equal(maxIso([undefined, "2026-09-01T12:00:00.000Z", "2026-08-01T12:00:00.000Z"]), "2026-09-01T12:00:00.000Z");
  assert.equal(minIso([null, undefined]), null);
});

test("fetchedNames is unique newest-first inject item names for one client", () => {
  const rows = [
    audit("inject", "2026-09-02T00:00:00.000Z", "STRIPE_KEY", "cli_a"),
    audit("inject", "2026-09-01T12:00:00.000Z", "SPOTIFY_TOKEN", "cli_a"),
    audit("inject", "2026-09-01T11:00:00.000Z", "STRIPE_KEY", "cli_a"),
    audit("grant", "2026-09-01T10:00:00.000Z", "OTHER", "cli_a"),
    audit("inject", "2026-09-01T09:00:00.000Z", "OTHER", "cli_b"),
  ];
  assert.deepEqual(fetchedNames(rows, "cli_a"), ["STRIPE_KEY", "SPOTIFY_TOKEN"]);
  assert.deepEqual(fetchedNames(rows, "cli_a", "STRIPE_KEY"), ["STRIPE_KEY"]);
  assert.deepEqual(fetchedNames(rows, "cli_missing"), []);
});

test("clientUsage uses first issue as created and inject or last_seen as access", () => {
  const usage = clientUsage(
    { lastTokenAt: "2026-09-01T18:00:00.000Z", lastSeenAt: "2026-09-02T10:00:00.000Z" },
    [event("cli_a", "2026-09-01T08:00:00.000Z"), event("cli_a", "2026-09-01T18:00:00.000Z")],
    [audit("inject", "2026-09-01T09:00:00.000Z", "STRIPE_KEY", "cli_a")],
    "cli_a",
  );
  assert.equal(usage.created_at, "2026-09-01T08:00:00.000Z");
  assert.equal(usage.first_access_at, "2026-09-01T09:00:00.000Z");
  assert.equal(usage.last_access_at, "2026-09-02T10:00:00.000Z");
  assert.deepEqual(usage.fetched, ["STRIPE_KEY"]);
});

test("grantUsage scopes fetched to that item; sessionUsage has no fetched names", () => {
  const grant = grantUsage(
    {
      createdAt: "2026-09-01T07:00:00.000Z",
      approvedAt: "2026-09-01T08:00:00.000Z",
      consumedAt: "2026-09-01T09:30:00.000Z",
    },
    [
      audit("inject", "2026-09-01T09:00:00.000Z", "STRIPE_KEY", "cli_a"),
      audit("inject", "2026-09-01T10:00:00.000Z", "SPOTIFY_TOKEN", "cli_a"),
    ],
    "cli_a",
    "STRIPE_KEY",
  );
  assert.equal(grant.created_at, "2026-09-01T07:00:00.000Z");
  assert.equal(grant.first_access_at, "2026-09-01T09:00:00.000Z");
  assert.equal(grant.last_access_at, "2026-09-01T09:30:00.000Z");
  assert.deepEqual(grant.fetched, ["STRIPE_KEY"]);
  const session = sessionUsage({
    createdAt: "2026-09-01T07:00:00.000Z",
    lastSeenAt: "2026-09-01T11:00:00.000Z",
  });
  assert.equal(session.first_access_at, session.created_at);
  assert.deepEqual(session.fetched, []);
});
