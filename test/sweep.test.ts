import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { scheduleSweeps } from "../src/hosted/boot.ts";
import type { SweepCounts } from "../src/store/types.ts";
import { cleanup, tempHome } from "./helpers.ts";

const NOW = "2026-09-04T12:00:00.000Z";
const iso = (offsetMs: number): string => new Date(Date.parse(NOW) + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

test("sweepExpired deletes only rows nothing can read again (sqlite-hosted)", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  try {
    // email OTP: one expired, one live
    await store.insertEmailOtp({ id: "otp_old", email: "a@x.io", codeScrypt: "h", expiresAt: iso(-HOUR), attempts: 0, sentAt: iso(-2 * HOUR) });
    await store.insertEmailOtp({ id: "otp_live", email: "a@x.io", codeScrypt: "h", expiresAt: iso(HOUR), attempts: 0, sentAt: iso(-1000) });
    // sessions
    await store.insertSession({ idHash: "s_old", userId: "u1", createdAt: iso(-48 * HOUR), lastSeenAt: iso(-30 * HOUR), expiresAt: iso(-HOUR), mfaAt: null });
    await store.insertSession({ idHash: "s_live", userId: "u1", createdAt: iso(-HOUR), lastSeenAt: iso(-1000), expiresAt: iso(8 * HOUR), mfaAt: null });
    // approval challenges
    await store.insertChallenge({ id: "c_old", grantId: "g1", codeHash: "h", expiresAt: iso(-HOUR), attempts: 0, kind: "code" });
    await store.insertChallenge({ id: "c_live", grantId: "g2", codeHash: "h", expiresAt: iso(HOUR), attempts: 0, kind: "code" });
    // needs: cancelled and old, pending and long expired, pending and fresh, cancelled but recent
    const need = (id: string, status: "pending" | "cancelled", createdAt: string, expiresAt: string) => ({
      id,
      orgId: "org1",
      clientId: "cl1",
      environmentId: "env1",
      suggestedName: `N_${id}`,
      host: `${id}.example.com`,
      taskDescription: null,
      status,
      itemId: null,
      grantId: null,
      expiresAt,
      createdAt,
      fulfilledAt: null,
    });
    await store.insertPendingNeed(need("n_cancelled_old", "pending", iso(-3 * 24 * HOUR), iso(-2 * 24 * HOUR)));
    await store.cancelNeed("n_cancelled_old");
    await store.insertPendingNeed(need("n_pending_expired", "pending", iso(-3 * 24 * HOUR), iso(-2 * 24 * HOUR)));
    await store.insertPendingNeed(need("n_pending_fresh", "pending", iso(-HOUR), iso(HOUR)));
    await store.insertPendingNeed(need("n_cancelled_recent", "pending", iso(-HOUR), iso(HOUR)));
    await store.cancelNeed("n_cancelled_recent");
    // rate hits: stale window and current window
    await store.incrementRateHit("org1", "grant", iso(-3 * HOUR));
    await store.incrementRateHit("org1", "grant", iso(-10 * 60 * 1000));
    // oidc payloads: expired, live, and no expiry (grants/clients live until revoked)
    await store.upsertOidcPayload({ id: "p_old", kind: "AccessToken", payload: "{}", expiresAt: iso(-HOUR) });
    await store.upsertOidcPayload({ id: "p_live", kind: "AccessToken", payload: "{}", expiresAt: iso(HOUR) });
    await store.upsertOidcPayload({ id: "p_forever", kind: "Client", payload: "{}", expiresAt: null });
    // org invites: expired more than a week ago, expired this week, live, and accepted long ago
    const DAY = 24 * HOUR;
    const invite = (id: string, expiresAt: string, acceptedAt: string | null = null) => ({
      id,
      orgId: "org1",
      email: `${id}@example.com`,
      role: "operator" as const,
      tokenHash: `hash_${id}`,
      invitedBy: "u1",
      createdAt: iso(-30 * DAY),
      expiresAt,
      acceptedAt,
    });
    await store.insertInvite(invite("inv_stale", iso(-8 * DAY)));
    await store.insertInvite(invite("inv_recent", iso(-2 * DAY)));
    await store.insertInvite(invite("inv_live", iso(5 * DAY)));
    await store.insertInvite(invite("inv_accepted", iso(-20 * DAY), iso(-25 * DAY)));

    const counts = await store.sweepExpired(NOW);
    assert.deepEqual(counts, {
      emailOtpChallenges: 1,
      operatorSessions: 1,
      approvalChallenges: 1,
      needItems: 2,
      rateHits: 1,
      oidcPayloads: 1,
      orgInvites: 1,
    } satisfies SweepCounts);

    assert.equal((await store.latestEmailOtp("a@x.io"))?.id, "otp_live");
    assert.equal(await store.getSession("s_old"), undefined);
    assert.ok(await store.getSession("s_live"));
    assert.equal(await store.getChallenge("c_old"), undefined);
    assert.ok(await store.getChallenge("c_live"));
    assert.equal(await store.getNeed("n_cancelled_old"), undefined);
    assert.equal(await store.getNeed("n_pending_expired"), undefined);
    assert.ok(await store.getNeed("n_pending_fresh"));
    assert.ok(await store.getNeed("n_cancelled_recent"), "a recent cancel stays visible for a day");
    assert.equal(await store.countRateHits("org1", "grant", iso(-3 * HOUR)), 0);
    assert.equal(await store.countRateHits("org1", "grant", iso(-10 * 60 * 1000)), 1);
    assert.equal(await store.getOidcPayload("p_old", "AccessToken"), undefined);
    assert.ok(await store.getOidcPayload("p_live", "AccessToken"));
    assert.ok(await store.getOidcPayload("p_forever", "Client"));
    assert.equal(await store.getInvite("inv_stale"), undefined, "an invite a week past expiry is gone");
    assert.ok(await store.getInvite("inv_recent"), "a recently expired invite stays listed as expired");
    assert.ok(await store.getInvite("inv_live"));
    assert.ok(await store.getInvite("inv_accepted"), "accepted invites are membership history");

    // second pass is a no-op
    const again = await store.sweepExpired(NOW);
    assert.deepEqual(Object.values(again), [0, 0, 0, 0, 0, 0, 0]);
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("scheduleSweeps runs at start, logs counts, swallows errors, and its timer never holds the process", async () => {
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const log = (event: string, fields: Record<string, unknown>) => {
    events.push({ event, fields });
  };
  let calls = 0;
  const zero: SweepCounts = {
    emailOtpChallenges: 0,
    operatorSessions: 0,
    approvalChallenges: 0,
    needItems: 3,
    rateHits: 0,
    oidcPayloads: 0,
    orgInvites: 0,
  };
  const store = {
    sweepExpired: async (nowIso: string): Promise<SweepCounts> => {
      calls += 1;
      if (calls === 2) throw new Error("db away");
      assert.equal(nowIso, NOW);
      return zero;
    },
  };
  const sched = scheduleSweeps(store, { intervalMs: 10, log, now: () => new Date(NOW) });
  try {
    const first = await sched.runOnce();
    assert.deepEqual(first, zero);
    assert.equal(events[0]?.event, "sweep_expired");
    assert.equal(events[0]?.fields.needItems, 3);
    const second = await sched.runOnce();
    assert.equal(second, undefined);
    assert.equal(events[1]?.event, "sweep_failed");
    assert.equal(events[1]?.fields.message, "db away");
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(calls >= 3, `interval fired (calls=${calls})`);
  } finally {
    sched.stop();
  }
});
