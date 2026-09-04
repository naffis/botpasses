import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import {
  assertWithinLimit,
  monthStartIso,
  parsePlanLimitsOverride,
  PLAN_LIMITS,
  PLAN_LIMITS_ENV,
  PlanLimitError,
  planLimits,
} from "../src/hosted/plan-limits.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

test("free tier limits and the env override", () => {
  assert.deepEqual(PLAN_LIMITS.free, { credentials: 25, agents: 10, members: 3, calls: 5000 });
  assert.deepEqual(planLimits("free", {}), PLAN_LIMITS.free);
  assert.deepEqual(planLimits("free", { [PLAN_LIMITS_ENV]: '{"credentials":100,"calls":50000}' }), {
    credentials: 100,
    agents: 10,
    members: 3,
    calls: 50000,
  });
  assert.deepEqual(parsePlanLimitsOverride(undefined), {});
  assert.deepEqual(parsePlanLimitsOverride("  "), {});
  assert.throws(() => parsePlanLimitsOverride("{"), /JSON object/);
  assert.throws(() => parsePlanLimitsOverride("[1]"), /JSON object/);
  assert.throws(() => parsePlanLimitsOverride('{"seats":3}'), /unknown limit "seats"/);
  assert.throws(() => parsePlanLimitsOverride('{"agents":0}'), /positive integer/);
  assert.throws(() => parsePlanLimitsOverride('{"agents":"10"}'), /positive integer/);
  assert.throws(() => parsePlanLimitsOverride('{"agents":2.5}'), /positive integer/);
});

test("assertWithinLimit is exact at the boundary and throws a 402 plan_limit", () => {
  const limits = { credentials: 3, agents: 1, members: 2, calls: 10 };
  assert.doesNotThrow(() => assertWithinLimit("credentials", 2, limits));
  assert.throws(
    () => assertWithinLimit("credentials", 3, limits),
    (err: unknown) =>
      err instanceof PlanLimitError &&
      err.status === 402 &&
      err.message === "plan_limit" &&
      err.kind === "credentials" &&
      err.limit === 3 &&
      err.extra.kind === "credentials" &&
      err.extra.limit === 3,
  );
  assert.throws(() => assertWithinLimit("agents", 5, limits), PlanLimitError);
  assert.equal(monthStartIso(new Date("2026-09-04T12:34:56Z")), "2026-09-01T00:00:00.000Z");
  assert.equal(monthStartIso(new Date("2026-01-01T00:00:00Z")), "2026-01-01T00:00:00.000Z");
});

async function kernelWithLimits(limits: { credentials: number; agents: number; members: number; calls: number }) {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "plan.sqlite"));
  const clock = { now: Date.parse("2026-09-15T10:00:00Z") };
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    deployPlane: "staging",
    planLimits: limits,
    now: () => new Date(clock.now),
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  return { home, store, kernel, orgId, clock };
}

const item = (n: number) => ({
  actor: "user_owner",
  environment: "staging" as const,
  kind: "secret" as const,
  name: `KEY_${n}`,
  value: CANARY,
  allowedHosts: ["api.example.com"],
  inject: "bearer",
});

test("kernel refuses the credential, agent, and call over the plan limit with 402", async () => {
  const ctx = await kernelWithLimits({ credentials: 2, agents: 1, members: 3, calls: 3 });
  const { kernel, orgId, store } = ctx;
  try {
    await kernel.createItem({ orgId, ...item(1) });
    await kernel.createItem({ orgId, ...item(2) });
    await assert.rejects(
      kernel.createItem({ orgId, ...item(3) }),
      (err: unknown) => err instanceof PlanLimitError && err.kind === "credentials" && err.limit === 2,
    );
    assert.equal((await kernel.listItems(orgId, "staging")).length, 2, "the refused item was not stored");

    await kernel.createModelClient({ orgId, name: "cursor", environment: "staging" });
    await assert.rejects(
      kernel.createModelClient({ orgId, name: "claude", environment: "staging" }),
      (err: unknown) => err instanceof PlanLimitError && err.kind === "agents",
    );
    await assert.rejects(
      kernel.createTrustedClient({ orgId, name: "runtime", environment: "staging" }),
      (err: unknown) => err instanceof PlanLimitError && err.kind === "agents",
    );
    const clients = await store.listClients(orgId);
    assert.equal(clients.length, 1);
    await kernel.revokeClient(orgId, "user_owner", clients[0]?.id ?? "");
    await kernel.createModelClient({ orgId, name: "claude", environment: "staging" });

    // Calls: three inject rows this month fill the budget; one from last month does not count.
    await store.insertAudit({ id: "aud_old", orgId, action: "inject", actor: "cli", itemName: "KEY_1", clientId: null, at: "2026-08-31T23:59:59.000Z" });
    await kernel.assertCallBudget(orgId);
    for (let i = 0; i < 3; i += 1) await kernel.writeAudit(orgId, "inject", "cli", "KEY_1", null);
    await assert.rejects(kernel.assertCallBudget(orgId), (err: unknown) => err instanceof PlanLimitError && err.kind === "calls" && err.limit === 3);

    const report = await kernel.planReport(orgId);
    assert.equal(report.plan, "free");
    assert.deepEqual(report.limits, { credentials: 2, agents: 1, members: 3, calls: 3 });
    assert.deepEqual(report.usage, { credentials: 2, agents: 1, members: 1, calls: 3 });
    assert.equal(report.period_start, "2026-09-01T00:00:00.000Z");
  } finally {
    await store.close();
    cleanup(ctx.home);
  }
});

test("HTTP: GET /api/plan reports usage; POST /api/items over the limit is 402 plan_limit", async () => {
  const ctx = await kernelWithLimits({ credentials: 1, agents: 10, members: 3, calls: 5000 });
  const http = createHostedServer({ kernel: ctx.kernel, host: "127.0.0.1", port: 0 });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const op = {
    "x-test-channel": "operator",
    "x-test-user": "user_owner",
    "x-test-org": ctx.orgId,
    "content-type": "application/json",
  };
  try {
    const first = await fetch(`${base}/api/items`, {
      method: "POST",
      headers: op,
      body: JSON.stringify({ name: "KEY_1", value: CANARY, environment: "staging", allowed_hosts: ["api.example.com"] }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/api/items`, {
      method: "POST",
      headers: op,
      body: JSON.stringify({ name: "KEY_2", value: CANARY, environment: "staging", allowed_hosts: ["api.example.com"] }),
    });
    assert.equal(second.status, 402);
    assert.deepEqual(await second.json(), { error: "plan_limit", kind: "credentials", limit: 1 });

    const plan = await fetch(`${base}/api/plan`, { headers: op });
    assert.equal(plan.status, 200);
    const body = (await plan.json()) as { plan: string; limits: Record<string, number>; usage: Record<string, number>; period_start: string };
    assert.equal(body.plan, "free");
    assert.equal(body.limits.credentials, 1);
    assert.equal(body.usage.credentials, 1);
    assert.equal(body.usage.members, 1);
    assert.equal(body.period_start, "2026-09-01T00:00:00.000Z");
    assert.ok(!JSON.stringify(body).includes(CANARY));

    const anon = await fetch(`${base}/api/plan`);
    assert.equal(anon.status, 401);
  } finally {
    await http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});
