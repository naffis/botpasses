import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { OrgRateLimiter } from "../src/hosted/rate-limit.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { cleanup, tempHome } from "./helpers.ts";

test("org rate limiter allows 30 hits then denies in the same hour", async () => {
  const limiter = new OrgRateLimiter();
  const now = 1_700_000_000_000;
  for (let i = 0; i < 30; i += 1) {
    assert.equal(await limiter.allow("org_1", now), true);
  }
  assert.equal(await limiter.allow("org_1", now), false);
  assert.equal(await limiter.allow("org_2", now), true);
  assert.equal(await limiter.allow("org_1", now + 60 * 60 * 1000 + 1), true);
});

test("store-backed limiter admits exactly 30 of 40 concurrent callers (S15 TOCTOU)", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "rate.sqlite"));
  try {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const limiter = new OrgRateLimiter(store);
    const results = await Promise.all(
      Array.from({ length: 40 }, () => limiter.allow("org_race", now, "grant")),
    );
    assert.equal(results.filter(Boolean).length, 30);
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("store-backed limiter holds the window across processes", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "rate.sqlite"));
  try {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const a = new OrgRateLimiter(store);
    for (let i = 0; i < 30; i += 1) {
      assert.equal(await a.allow("org_1", now, "grant"), true);
    }
    const b = new OrgRateLimiter(store);
    assert.equal(await b.allow("org_1", now, "need"), false);
  } finally {
    await store.close();
    cleanup(home);
  }
});
