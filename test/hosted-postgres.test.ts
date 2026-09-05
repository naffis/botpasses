import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { testAuthResolver } from "../src/hosted/auth.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { PostgresStore } from "../src/store/postgres.ts";
import { CANARY } from "./helpers.ts";

const dbUrl = process.env.DATABASE_URL;

test("AC-10 two processes: exactly one prompt consume on Postgres", async (t) => {
  if (!dbUrl) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const store = await PostgresStore.open(dbUrl);
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
  });
  const { orgId } = await kernel.createOrg(`org_${randomUUID()}`, "user_owner");
  await kernel.createItem({
    orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: "CAS_KEY",
    value: CANARY,
    allowedHosts: ["api.stripe.com"],
    inject: "bearer",
  });
  const { client: model } = await kernel.createModelClient({
    orgId,
    name: "m",
    environment: "staging",
  });
  const asked = await kernel.requestGrant({
    orgId,
    clientId: model.id,
    itemName: "CAS_KEY",
    environment: "staging",
  });
  await kernel.approveGrant({
    orgId,
    grantId: asked.grant.id,
    policy: "prompt",
    role: "owner",
    actor: "user_owner",
  });
  const worker = fileURLToPath(new URL("./helpers/cas-worker.ts", import.meta.url));
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          worker,
          asked.grant.id,
        ],
        { env: { ...process.env, DATABASE_URL: dbUrl } },
      );
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`worker exit ${code}`));
        else resolve(out);
      });
    });
  const [a, b] = await Promise.all([run(), run()]);
  const wins = [a, b].filter((x) => x === "1").length;
  assert.equal(wins, 1);
  await store.close();
});

test("PostgresStore.open rejects (does not exit) on an unreachable database", async (t) => {
  if (!dbUrl) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const bad = dbUrl.replace(/\/\/([^@]*@)?[^/:]+(:\d+)?/, "//vault:vault@127.0.0.1:1");
  await assert.rejects(PostgresStore.open(bad, { plane: "test" }));
});

test("pool options carry client timeouts and an application_name, not PgBouncer-rejected startup params", () => {
  const opts = PostgresStore.poolOptions("postgres://u:p@h/db", { plane: "staging" });
  assert.equal(opts.connectionTimeoutMillis, 5000);
  assert.equal(opts.idleTimeoutMillis, 30000);
  assert.equal(opts.application_name, "botpasses-staging");
  assert.equal(opts.keepAlive, true);
  // Neon -pooler (PgBouncer) refuses these startup parameters; sending them takes staging down.
  assert.equal(opts.statement_timeout, undefined);
  assert.equal(opts.options, undefined);
});

test("sweepExpired on Postgres deletes expired OTP, sessions, challenges, needs, rate hits, oidc payloads", async (t) => {
  if (!dbUrl) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const store = await PostgresStore.open(dbUrl, { plane: "test" });
  const now = new Date();
  const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();
  const HOUR = 3_600_000;
  const tag = randomUUID().slice(0, 8);
  try {
    await store.insertEmailOtp({ id: `otp_old_${tag}`, email: `${tag}@x.io`, codeScrypt: "h", expiresAt: iso(-HOUR), attempts: 0, sentAt: iso(-2 * HOUR) });
    await store.insertEmailOtp({ id: `otp_live_${tag}`, email: `${tag}@x.io`, codeScrypt: "h", expiresAt: iso(HOUR), attempts: 0, sentAt: iso(-1000) });
    await store.insertSession({ idHash: `s_old_${tag}`, userId: `u_${tag}`, createdAt: iso(-48 * HOUR), lastSeenAt: iso(-30 * HOUR), expiresAt: iso(-HOUR), mfaAt: null });
    await store.insertSession({ idHash: `s_live_${tag}`, userId: `u_${tag}`, createdAt: iso(-HOUR), lastSeenAt: iso(-1000), expiresAt: iso(8 * HOUR), mfaAt: null });
    await store.insertChallenge({ id: `c_old_${tag}`, grantId: `g_${tag}`, codeHash: "h", expiresAt: iso(-HOUR), attempts: 0, kind: "code" });
    await store.insertChallenge({ id: `c_live_${tag}`, grantId: `g2_${tag}`, codeHash: "h", expiresAt: iso(HOUR), attempts: 0, kind: "code" });
    await store.incrementRateHit(`org_${tag}`, "grant", iso(-3 * HOUR));
    await store.incrementRateHit(`org_${tag}`, "grant", iso(-10 * 60_000));
    await store.upsertOidcPayload({ id: `p_old_${tag}`, kind: "AccessToken", payload: "{}", expiresAt: iso(-HOUR) });
    await store.upsertOidcPayload({ id: `p_live_${tag}`, kind: "AccessToken", payload: "{}", expiresAt: iso(HOUR) });
    await store.upsertOidcPayload({ id: `p_forever_${tag}`, kind: "Client", payload: "{}", expiresAt: null });
    const DAY = 24 * HOUR;
    const invite = (id: string, expiresAt: string) => ({
      id,
      orgId: `org_${tag}`,
      email: `${id}@example.com`,
      role: "operator" as const,
      tokenHash: `hash_${id}`,
      invitedBy: `u_${tag}`,
      createdAt: iso(-30 * DAY),
      expiresAt,
      acceptedAt: null,
    });
    await store.insertInvite(invite(`inv_stale_${tag}`, iso(-8 * DAY)));
    await store.insertInvite(invite(`inv_recent_${tag}`, iso(-2 * DAY)));

    const counts = await store.sweepExpired(now.toISOString());
    assert.ok(counts.emailOtpChallenges >= 1);
    assert.ok(counts.operatorSessions >= 1);
    assert.ok(counts.approvalChallenges >= 1);
    assert.ok(counts.rateHits >= 1);
    assert.ok(counts.oidcPayloads >= 1);
    assert.ok(counts.orgInvites >= 1);
    assert.equal(await store.getInvite(`inv_stale_${tag}`), undefined);
    assert.ok(await store.getInvite(`inv_recent_${tag}`), "an invite expired this week is kept");
    await store.deleteInvite(`inv_recent_${tag}`);
    assert.equal((await store.latestEmailOtp(`${tag}@x.io`))?.id, `otp_live_${tag}`);
    assert.equal(await store.getSession(`s_old_${tag}`), undefined);
    assert.ok(await store.getSession(`s_live_${tag}`));
    assert.equal(await store.getChallenge(`c_old_${tag}`), undefined);
    assert.ok(await store.getChallenge(`c_live_${tag}`));
    assert.equal(await store.countRateHits(`org_${tag}`, "grant", iso(-3 * HOUR)), 0);
    assert.equal(await store.countRateHits(`org_${tag}`, "grant", iso(-10 * 60_000)), 1);
    assert.equal(await store.getOidcPayload(`p_old_${tag}`, "AccessToken"), undefined);
    assert.ok(await store.getOidcPayload(`p_live_${tag}`, "AccessToken"));
    assert.ok(await store.getOidcPayload(`p_forever_${tag}`, "Client"));
    await store.deleteOidcPayload(`p_forever_${tag}`, "Client");
    await store.deleteOidcPayload(`p_live_${tag}`, "AccessToken");
    await store.deleteSession(`s_live_${tag}`);
    await store.deleteChallenge(`c_live_${tag}`);
  } finally {
    await store.close();
  }
});

test("AC-11 GET /ready is 200 against Postgres", async (t) => {
  if (!dbUrl) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const store = await PostgresStore.open(dbUrl);
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
  });
  const http = createHostedServer({ kernel, host: "127.0.0.1", port: 0, authResolver: testAuthResolver });
  const addr = await http.listen();
  try {
    const res = await fetch(`http://${addr.host}:${addr.port}/ready`);
    assert.equal(res.status, 200);
  } finally {
    await http.close();
    await store.close();
  }
});
