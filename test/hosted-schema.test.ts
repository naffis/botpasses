import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import type { VaultStore } from "../src/store/types.ts";
import { cleanup, tempHome } from "./helpers.ts";

test("empty org has no items; sqlite store satisfies VaultStore", async () => {
  const home = tempHome();
  const store: VaultStore = openHostedSqlite(join(home, "empty.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
  });
  try {
    const { orgId } = await kernel.createOrg("empty", "owner");
    const items = await kernel.listItems(orgId, "staging");
    assert.deepEqual(items, []);
    await store.ping();
  } finally {
    await store.close();
    cleanup(home);
  }
});
