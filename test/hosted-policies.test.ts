import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import type { GrantPolicy, MemberRole } from "../src/hosted-types.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { cleanup, tempHome } from "./helpers.ts";

const cases: {
  name: string;
  policy: GrantPolicy;
  role: MemberRole;
  confirmName?: string;
  expect: "active" | "reject";
}[] = [
  { name: "prompt operator", policy: "prompt", role: "operator", expect: "active" },
  { name: "session owner", policy: "session", role: "owner", expect: "active" },
  { name: "item_standing operator", policy: "item_standing", role: "operator", expect: "active" },
  { name: "folder_standing operator", policy: "folder_standing", role: "operator", confirmName: "staging", expect: "reject" },
  { name: "folder_standing owner missing confirm", policy: "folder_standing", role: "owner", expect: "reject" },
  { name: "folder_standing owner confirm", policy: "folder_standing", role: "owner", confirmName: "staging", expect: "active" },
];

for (const c of cases) {
  test(`policy matrix: ${c.name}`, async () => {
    const home = tempHome();
    const store = openHostedSqlite(join(home, "p.sqlite"));
    const kernel = new HostedKernel({
      store,
      kek: parseMasterKey(generateMasterKey()),
    });
    try {
      const { orgId } = await kernel.createOrg("acme", "user_owner");
      await kernel.addMember(orgId, "user_op", "operator");
      await kernel.createItem({
        orgId,
        actor: "user_owner",
        environment: "staging",
        kind: "secret",
        name: "K",
        value: "abcd",
        allowedHosts: ["api.stripe.com"],
        inject: "bearer",
      });
      const model = await kernel.createModelClient({ orgId, name: "m", environment: "staging" });
      const asked = await kernel.requestGrant({
        orgId,
        clientId: model.id,
        itemName: "K",
        environment: "staging",
      });
      const actor = c.role === "owner" ? "user_owner" : "user_op";
      if (c.expect === "active") {
        const grant = await kernel.approveGrant({
          orgId,
          grantId: asked.grant.id,
          policy: c.policy,
          confirmName: c.confirmName,
          role: c.role,
          actor,
        });
        assert.equal(grant.status, "active");
      } else {
        await assert.rejects(
          () =>
            kernel.approveGrant({
              orgId,
              grantId: asked.grant.id,
              policy: c.policy,
              confirmName: c.confirmName,
              role: c.role,
              actor,
            }),
        );
        const still = await kernel.store.getGrant(asked.grant.id);
        assert.equal(still?.status, "pending");
      }
    } finally {
      await store.close();
      cleanup(home);
    }
  });
}
