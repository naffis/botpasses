import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HERO_SERVICES,
  nextHeroIndex,
  parseHeroServices,
} from "../site/src/lib/hero-services.ts";

test("hero services start with Stripe, stay unique, and cover more than one vendor", () => {
  assert.equal(HERO_SERVICES[0], "Stripe");
  assert.ok(HERO_SERVICES.length >= 40, `expected a long list, got ${HERO_SERVICES.length}`);
  assert.equal(new Set(HERO_SERVICES).size, HERO_SERVICES.length);
  for (const name of HERO_SERVICES) {
    assert.ok(name.length > 0 && name.length <= 12, name);
    assert.doesNotMatch(name, /—/);
  }
  for (const name of ["Slack", "GitHub", "Google", "Spotify", "Salesforce", "Twilio"]) {
    assert.ok(HERO_SERVICES.some((s) => s === name), name);
  }
});

test("nextHeroIndex wraps", () => {
  assert.equal(nextHeroIndex(0, 3), 1);
  assert.equal(nextHeroIndex(2, 3), 0);
  assert.equal(nextHeroIndex(0, 0), 0);
});

test("parseHeroServices reads the homepage data attribute", () => {
  assert.deepEqual(parseHeroServices("Stripe|Slack|GitHub"), ["Stripe", "Slack", "GitHub"]);
  assert.deepEqual(parseHeroServices(" Stripe | | Slack "), ["Stripe", "Slack"]);
  assert.deepEqual(parseHeroServices(""), []);
});
