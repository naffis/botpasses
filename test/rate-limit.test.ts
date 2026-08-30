import assert from "node:assert/strict";
import { test } from "node:test";
import { OrgRateLimiter } from "../src/hosted/rate-limit.ts";

test("org rate limiter allows 30 hits then denies in the same hour", () => {
  const limiter = new OrgRateLimiter();
  const now = 1_700_000_000_000;
  for (let i = 0; i < 30; i += 1) {
    assert.equal(limiter.allow("org_1", now), true);
  }
  assert.equal(limiter.allow("org_1", now), false);
  assert.equal(limiter.allow("org_2", now), true);
  assert.equal(limiter.allow("org_1", now + 60 * 60 * 1000 + 1), true);
});
