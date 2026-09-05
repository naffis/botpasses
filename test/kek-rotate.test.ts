import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { IDENTITY_KEY_ID, IdentityKeyring } from "../src/hosted/identity-keys.ts";
import { unwrapDek } from "../src/hosted/kek.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

test("a running process on the new KEK with VAULT_KEK_PREVIOUS opens DEKs still under the old one and re-wraps them in place (G4)", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "dual.sqlite"));
  const kekA = parseMasterKey(generateMasterKey());
  const kekB = parseMasterKey(generateMasterKey());
  const now = () => new Date("2026-09-04T12:00:00.000Z");
  const before = new HostedKernel({ store, kek: kekA, now });
  try {
    const { orgId } = await before.createOrg("one", "user_a");
    const item = await before.createItem({
      orgId,
      actor: "user_a",
      environment: "staging",
      kind: "secret",
      name: "STRIPE_KEY",
      value: CANARY,
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    const identityA = new IdentityKeyring(store, kekA, now);
    const totp = await identityA.wrap("user_a", "totp", "JBSWY3DPEHPK3PXP");

    // The new KEK alone cannot open the org: rotation would need a maintenance window.
    const onlyB = new HostedKernel({ store, kek: kekB, now });
    await assert.rejects(() => onlyB.decryptItem(orgId, item.id));

    const dual = new HostedKernel({ store, kek: kekB, previousKek: kekA, now });
    assert.equal((await dual.decryptItem(orgId, item.id)).secret, CANARY);
    const org = await store.getOrg(orgId);
    assert.ok(org);
    const envelope = { iv: org.wrappedDekIv, ciphertext: org.wrappedDekCiphertext, tag: org.wrappedDekTag };
    unwrapDek(envelope, kekB, orgId);
    assert.throws(() => unwrapDek(envelope, kekA, orgId), "the row now lives under the current KEK");
    const audit = await store.listAudit(orgId, 10);
    assert.equal(audit.filter((a) => a.action === "dek_rewrapped").length, 1);
    assert.equal((await dual.decryptItem(orgId, item.id)).secret, CANARY);
    assert.equal((await store.listAudit(orgId, 10)).filter((a) => a.action === "dek_rewrapped").length, 1, "re-wrapped once");
    assert.equal((await onlyB.decryptItem(orgId, item.id)).secret, CANARY, "the new KEK alone now opens it");

    // The identity DEK follows the same rule.
    const identityDual = new IdentityKeyring(store, kekB, now, kekA);
    assert.equal((await identityDual.unwrap("user_a", "totp", totp)).secret, "JBSWY3DPEHPK3PXP");
    const row = await store.getIdentityKey(IDENTITY_KEY_ID);
    assert.ok(row);
    unwrapDek({ iv: row.wrappedIv, ciphertext: row.wrappedCiphertext, tag: row.wrappedTag }, kekB, IDENTITY_KEY_ID);
    assert.equal((await new IdentityKeyring(store, kekB, now).unwrap("user_a", "totp", totp)).secret, "JBSWY3DPEHPK3PXP");
    assert.ok(!JSON.stringify(audit).includes(CANARY));
  } finally {
    await store.close();
    cleanup(home);
  }
});

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
    const decrypted = await kernelB.decryptItem(a.orgId, items[0].id);
    assert.equal(decrypted.secret, CANARY);
    assert.ok(b.orgId);
  } finally {
    await store.close();
    cleanup(home);
  }
});
