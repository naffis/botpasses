import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { unwrapDek } from "../src/hosted/kek.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

test("rotateKek re-wraps DEKs and resumes after a mid-org crash", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "rotate.sqlite"));
  const kekA = parseMasterKey(generateMasterKey());
  const kekB = parseMasterKey(generateMasterKey());
  const kernel = new HostedKernel({ store, kek: kekA });
  try {
    const a = await kernel.createOrg("one", "user_a");
    const b = await kernel.createOrg("two", "user_b");
    await kernel.createItem({
      orgId: a.orgId,
      actor: "user_a",
      environment: "staging",
      kind: "secret",
      name: "STRIPE_KEY",
      value: CANARY,
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    const first = await kernel.rotateKek(kekA, kekB);
    assert.equal(first.rewrapped, 2);
    assert.equal(first.skipped, 0);
    const orgA = await store.getOrg(a.orgId);
    assert.ok(orgA);
    unwrapDek(
      { iv: orgA.wrappedDekIv, ciphertext: orgA.wrappedDekCiphertext, tag: orgA.wrappedDekTag },
      kekB,
      a.orgId,
    );
    assert.throws(() =>
      unwrapDek(
        { iv: orgA.wrappedDekIv, ciphertext: orgA.wrappedDekCiphertext, tag: orgA.wrappedDekTag },
        kekA,
        a.orgId,
      ),
    );
    const resumed = await kernel.rotateKek(kekA, kekB);
    assert.equal(resumed.skipped, 2);
    assert.equal(resumed.rewrapped, 0);
    const kernelB = new HostedKernel({ store, kek: kekB });
    const items = await kernelB.listItems(a.orgId, "staging");
    assert.equal(items[0]?.last4, CANARY.slice(-4));
    const decrypted = await kernelB.decryptItem(a.orgId, items[0]!.id);
    assert.equal(decrypted.secret, CANARY);
    assert.ok(b.orgId);
  } finally {
    await store.close();
    cleanup(home);
  }
});
