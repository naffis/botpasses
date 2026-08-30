import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { AgentPassAuthority } from "../src/hosted/agentpass.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { cleanup, tempHome } from "./helpers.ts";

test("AgentPass issuance pending, approve, validate consumes, holder_proof required", async () => {
  process.env.VAULT_AGENTPASS = "1";
  const home = tempHome();
  const store = openHostedSqlite(join(home, "ap.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: "http://127.0.0.1:8788",
  });
  const { orgId } = await kernel.createOrg("ap", "user_owner");
  const http = createHostedServer({ kernel, host: "127.0.0.1", port: 0 });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const op = {
    "x-test-channel": "operator",
    "x-test-user": "user_owner",
    "x-test-org": orgId,
    "content-type": "application/json",
  };
  try {
    const cfg = await (await fetch(`${base}/agentpass/configuration`)).json();
    assert.ok(cfg && typeof cfg === "object");
    const created = await fetch(`${base}/agentpass/requests`, {
      method: "POST",
      headers: op,
      body: JSON.stringify({ holder_cnf: "cnf-1", scope: ["read"], task_id: "t1" }),
    });
    const body = (await created.json()) as { id: string; status: string };
    assert.equal(body.status, "pending");
    const pendingInbox = (await (await fetch(`${base}/api/inbox`, { headers: op })).json()) as {
      grants: unknown[];
      agentpass: { id?: string; status: string }[];
    };
    assert.ok(pendingInbox.agentpass.some((p) => p.status === "pending"));
    const missing = await fetch(`${base}/agentpass/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: body.id }),
    });
    assert.equal(missing.status, 401);
    await fetch(`${base}/agentpass/requests/${body.id}/approve`, { method: "POST", headers: op });
    const first = await fetch(`${base}/agentpass/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: body.id, holder_proof: { cnf: "cnf-1" } }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/agentpass/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: body.id, holder_proof: { cnf: "cnf-1" } }),
    });
    assert.equal(second.status, 409);
    const authority = new AgentPassAuthority(kernel, base);
    assert.ok(authority.jwks().keys.length >= 1);
  } finally {
    delete process.env.VAULT_AGENTPASS;
    await http.close();
    await store.close();
    cleanup(home);
  }
});
