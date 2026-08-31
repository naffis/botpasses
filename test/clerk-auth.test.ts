import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { principalFromClerkClaims } from "../src/hosted/clerk-auth.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { cleanup, tempHome } from "./helpers.ts";

test("Clerk session JWT with sid is an operator, not the first model client", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "c.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
  });
  try {
    const { orgId } = await kernel.createOrg("acme", "user_owner");
    const grok = (await kernel.createModelClient({
      orgId,
      name: "grok",
      environment: "staging",
      clerkOauthUserId: "azp_grok",
    })).client;
    const session = await principalFromClerkClaims(kernel, {
      sub: "user_owner",
      org_id: orgId,
      azp: "mcp-something",
      sid: "sess_abc",
    });
    assert.equal(session.channel, "operator");
    if (session.channel === "operator") {
      assert.equal(session.userId, "user_owner");
    }
    const oauth = await principalFromClerkClaims(kernel, {
      sub: "oauth_sub",
      org_id: orgId,
      azp: "azp_grok",
      sid: null,
    });
    assert.equal(oauth.channel, "model");
    if (oauth.channel === "model") {
      assert.equal(oauth.clientId, grok.id);
    }
    const prod = (await kernel.createModelClient({
      orgId,
      name: "prod-mcp",
      environment: "production",
      clerkOauthUserId: "azp_prod",
    })).client;
    const prodOauth = await principalFromClerkClaims(kernel, {
      sub: "oauth_sub",
      org_id: orgId,
      azp: "azp_prod",
      sid: null,
    });
    assert.equal(prodOauth.channel, "model");
    if (prodOauth.channel === "model") {
      assert.equal(prodOauth.clientId, prod.id);
      assert.equal(prodOauth.environment, "production");
    }
    const other = await principalFromClerkClaims(kernel, {
      sub: "oauth_sub",
      org_id: orgId,
      azp: "azp_chatgpt",
      sid: null,
    });
    assert.equal(other.channel, "model");
    if (other.channel === "model") {
      assert.notEqual(other.clientId, grok.id);
    }
  } finally {
    await store.close();
    cleanup(home);
  }
});
