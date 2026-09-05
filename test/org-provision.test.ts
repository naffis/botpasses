/**
 * Personal org provisioning (G2): random org ids, `created_by` on the row, an empty org a user
 * created is reclaimed, and an owner removed from the org they created never regains it.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { cleanup, tempHome } from "./helpers.ts";

async function setup() {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "orgs.sqlite"));
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()) });
  return { home, store, kernel };
}

test("a removed owner does not regain the org they created through a deterministic id (G2 reentry)", async () => {
  const { home, store, kernel } = await setup();
  try {
    const first = await kernel.ensureVaultOrgForUser("usr_alice");
    assert.notEqual(first.orgId, "org_alice", "personal org ids are random, not derived from the user id");
    assert.match(first.orgId, /^org_[0-9a-f-]{36}$/);
    assert.equal((await store.getOrg(first.orgId))?.createdBy, "usr_alice");

    await kernel.addMember(first.orgId, "usr_bob", "owner");
    await store.removeMember(first.orgId, "usr_alice");

    const again = await kernel.ensureVaultOrgForUser("usr_alice");
    assert.notEqual(again.orgId, first.orgId, "the removed creator lands in a fresh org");
    assert.equal(again.role, "owner");
    assert.equal(await store.getMember(first.orgId, "usr_alice"), undefined, "no way back into Bob's org");
    assert.deepEqual((await store.listMembers(first.orgId)).map((m) => m.userId), ["usr_bob"]);
    assert.deepEqual((await store.listMembershipsForUser("usr_alice")).map((m) => m.orgId), [again.orgId]);

    const third = await kernel.ensureVaultOrgForUser("usr_alice");
    assert.equal(third.orgId, again.orgId, "idempotent once a membership exists");
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("an org the user created that has no members at all is reclaimed instead of provisioning another (G2)", async () => {
  const { home, store, kernel } = await setup();
  try {
    const { orgId } = await kernel.createOrg("solo", "usr_carol");
    await store.removeMember(orgId, "usr_carol");
    assert.deepEqual(await store.listMembers(orgId), []);
    const back = await kernel.ensureVaultOrgForUser("usr_carol");
    assert.deepEqual(back, { orgId, role: "owner" });
    assert.equal((await store.listOrgsCreatedBy("usr_carol")).length, 1, "no second org was created");
    assert.ok(await kernel.envFor(orgId, "staging"), "the reclaimed org is fully provisioned");
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("provisioning writes the owner membership last, so an org without members is a stopped provisioning (G2)", async () => {
  const { home, store, kernel } = await setup();
  try {
    const calls: string[] = [];
    const spy = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        const method = value as (...a: unknown[]) => unknown;
        if (prop === "insertOrg" || prop === "insertVault" || prop === "insertMember") {
          return (...args: unknown[]) => {
            calls.push(String(prop));
            return method.apply(target, args);
          };
        }
        return method.bind(target);
      },
    });
    const spied = new HostedKernel({ store: spy, kek: parseMasterKey(generateMasterKey()) });
    await spied.ensureVaultOrgForUser("usr_dave");
    assert.deepEqual(calls, ["insertOrg", "insertVault", "insertMember"]);
    assert.ok(kernel);
  } finally {
    await store.close();
    cleanup(home);
  }
});
