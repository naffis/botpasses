import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { dbPath } from "../src/db.ts";
import { testAuthResolver } from "../src/hosted/auth.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { handleHostedMcpRpc, listHostedMcpTools } from "../src/hosted/mcp.ts";
import { callMcpTool, handleMcpRpc, listMcpTools, newMcpSession } from "../src/mcp.ts";
import { transcriptContainsSecret } from "../src/redact.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, ChatTranscript, cleanup, makeVault, tempHome } from "./helpers.ts";

test("mocked LLM/agent conversation never contains the stored secret after store, grant, or use", async () => {
  const { vault, home } = makeVault();
  const chat = new ChatTranscript();

  try {
    const stored = vault.setSecret("STRIPE_KEY", CANARY);
    chat.add(
      "operator",
      `Stored named secret ${stored.name} last4=${stored.last4}. Value is not shown again.`,
    );

    const listSecrets = await callMcpTool(vault, "list_secrets", {});
    chat.add("agent", { tool: "list_secrets", result: listSecrets });

    const session = newMcpSession();
    session.agentId = "invoicer";
    const requested = await callMcpTool(vault, "request_grant", { item_name: "STRIPE_KEY", scope: "once" }, { session });
    chat.add("agent", { tool: "request_grant", result: requested });

    const grant = vault.approveGrant({
      secretName: "STRIPE_KEY",
      agentId: "invoicer",
      toolId: "http_request",
      scope: "once",
    });
    chat.add(
      "operator",
      `Approved grant ${grant.id} secret=${grant.secretName} tool=${grant.toolId} agent=${grant.agentId} scope=${grant.scope}. Value not shown.`,
    );

    const listedGrants = await callMcpTool(vault, "list_grants", {}, { session });
    chat.add("agent", { tool: "list_grants", result: listedGrants });
    vault.approveGrant({ secretName: "STRIPE_KEY", agentId: "invoicer", toolId: "stripe", scope: "once" });

    const tools = await handleMcpRpc(vault, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    chat.add("agent", { tool: "tools/list", result: tools });

    const run = await vault.runWithSecrets({
      bindings: [{ secretName: "STRIPE_KEY" }],
      agentId: "invoicer",
      toolId: "stripe",
      command: [
        process.execPath,
        "-e",
        `const v = process.env.STRIPE_KEY || ""; console.log(JSON.stringify({ injected: true, last4: v.slice(-4) }));`,
      ],
    });
    // PROBE_PATH must be on the child env — pass it via a side file written before spawn
    chat.add("runtime", {
      event: "grant_used",
      stdout: run.stdout,
      stderr: run.stderr,
      code: run.code,
      note: "Runtime injected the secret into the child env. Chat records that a grant happened, not the value.",
    });

    const audit = vault.listAudit();
    chat.add("operator", { tool: "audit", result: audit });

    const revoked = vault.revokeGrant({ grantId: grant.id });
    chat.add("operator", { tool: "revoke", result: revoked.map((g) => ({ id: g.id, status: g.status })) });

    const transcript = chat.serialize();
    assert.equal(transcriptContainsSecret(transcript, CANARY), false, transcript);
    assert.equal(transcriptContainsSecret(listMcpTools(), CANARY), false);
    assert.ok(!readFileSync(dbPath(home)).toString("utf8").includes(CANARY));
    assert.match(transcript, /STRIPE_KEY/);
    assert.match(transcript, /last4/);
    assert.ok(!/"value"\s*:/.test(transcript));
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("child process receives the plaintext; parent/chat surfaces do not", async () => {
  const { vault, home } = makeVault();
  const probe = join(home, "probe.json");
  writeFileSync(join(home, "placeholder"), "");
  try {
    vault.setSecret("STRIPE_KEY", CANARY);
    vault.approveGrant({
      secretName: "STRIPE_KEY",
      agentId: "invoicer",
      toolId: "stripe",
      scope: "session",
    });

    const script = join(home, "child.mjs");
    writeFileSync(
      script,
      `
        import { writeFileSync } from "node:fs";
        const v = process.env.STRIPE_KEY || "";
        writeFileSync(${JSON.stringify(probe)}, JSON.stringify({
          len: v.length,
          last4: v.slice(-4),
          matches: v === ${JSON.stringify(CANARY)}
        }));
        console.log(JSON.stringify({ child: "started", last4: v.slice(-4) }));
      `,
    );

    const run = await vault.runWithSecrets({
      bindings: [{ secretName: "STRIPE_KEY" }],
      agentId: "invoicer",
      toolId: "stripe",
      command: [process.execPath, script],
    });

    assert.equal(run.code, 0);
    assert.ok(!run.stdout.includes(CANARY));
    assert.ok(!run.stderr.includes(CANARY));
    const probeBody = JSON.parse(readFileSync(probe, "utf8")) as {
      len: number;
      last4: string;
      matches: boolean;
    };
    assert.equal(probeBody.matches, true);
    assert.equal(probeBody.len, CANARY.length);
    assert.equal(probeBody.last4, CANARY.slice(-4));
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("hosted MCP REST email audit never contain the stored canary", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const emails: { html: string }[] = [];
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    sendEmail: async (_to, _subject, html) => {
      emails.push({ html });
    },
    publicUrl: "http://127.0.0.1:8788",
  });
  const { orgId } = await kernel.createOrg("iso", "user_owner");
  await kernel.createItem({
    orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: "STRIPE_KEY",
    value: CANARY,
    allowedHosts: ["api.stripe.com"],
    inject: "bearer",
  });
  const { client: model } = await kernel.createModelClient({ orgId, name: "grok", environment: "staging" });
  const http = createHostedServer({
    authResolver: testAuthResolver,
    kernel,
    host: "127.0.0.1",
    port: 0,
    fetchImpl: async () => new Response(JSON.stringify({ echo: CANARY }), { status: 200 }),
    resolveAddresses: async () => ["8.8.8.8"],
  });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const modelH = {
    "content-type": "application/json",
    "x-test-channel": "model",
    "x-test-client": model.id,
  };
  const op = {
    "content-type": "application/json",
    "x-test-channel": "operator",
    "x-test-user": "user_owner",
    "x-test-org": orgId,
  };
  const chat = new ChatTranscript();
  try {
    const listed = await handleHostedMcpRpc(
      {
        kernel,
        principal: { channel: "model", orgId, clientId: model.id, environment: "staging" },
        fetchImpl: async () => new Response("{}", { status: 200 }),
        resolveAddresses: async () => ["8.8.8.8"],
      },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_items", arguments: {} } },
    );
    chat.add("agent", listed);
    const requested = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modelH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "request_grant", arguments: { item_name: "STRIPE_KEY" } },
      }),
    });
    chat.add("agent", await requested.json());
    const grants = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modelH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_grants", arguments: {} },
      }),
    });
    chat.add("agent", await grants.json());
    const inbox = await (await fetch(`${base}/api/inbox`, { headers: op })).json();
    const audit = await (await fetch(`${base}/api/audit`, { headers: op })).json();
    chat.add("operator", { inbox, audit, emails });
    const blob = chat.serialize() + JSON.stringify({ inbox, audit, emails, tools: listHostedMcpTools() });
    assert.equal(transcriptContainsSecret(blob, CANARY), false, blob);
    assert.ok(!readFileSync(join(home, "hosted.sqlite")).toString("utf8").includes(CANARY));
  } finally {
    await http.close();
    await store.close();
    cleanup(home);
  }
});

test("hosted find then operator fulfill never leaks canary into MCP collect HTML or inbox", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: "http://127.0.0.1:8788",
    deployPlane: "staging",
  });
  const { orgId } = await kernel.createOrg("iso", "user_owner");
  const { client: model } = await kernel.createModelClient({
    orgId,
    name: "grok",
    environment: "staging",
  });
  const http = createHostedServer({
    authResolver: testAuthResolver,
    kernel,
    host: "127.0.0.1",
    port: 0,
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${CANARY}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    resolveAddresses: async () => ["8.8.8.8"],
  });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const op = {
    "content-type": "application/json",
    "x-test-channel": "operator",
    "x-test-user": "user_owner",
    "x-test-org": orgId,
  };
  const chat = new ChatTranscript();
  try {
    const found = await handleHostedMcpRpc(
      { kernel, principal: { channel: "model", orgId, clientId: model.id, environment: "staging" } },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "find_items", arguments: { host: "api.spotify.com" } },
      },
    );
    chat.add("agent", found);
    const text = (found as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? "{}";
    const miss = JSON.parse(text) as { need_id?: string; collect_url?: string };
    const collect = await (await fetch(`${base}/collect/${miss.need_id}`)).text();
    chat.add("operator", collect);
    const fulfill = await fetch(`${base}/api/need-items/${miss.need_id}/fulfill`, {
      method: "POST",
      headers: op,
      body: JSON.stringify({
        name: "SPOTIFY_TOKEN",
        value: CANARY,
        allowed_hosts: ["api.spotify.com"],
        inject: "bearer",
      }),
    });
    chat.add("operator", await fulfill.json());
    const used = await handleHostedMcpRpc(
      {
        kernel,
        principal: { channel: "model", orgId, clientId: model.id, environment: "staging" },
        fetchImpl: async (_url, init) => {
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), `Bearer ${CANARY}`);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        resolveAddresses: async () => ["8.8.8.8"],
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "http_request",
          arguments: { item_name: "SPOTIFY_TOKEN", method: "GET", path: "/v1/me" },
        },
      },
    );
    chat.add("agent", used);
    const inbox = await (await fetch(`${base}/api/inbox`, { headers: op })).json();
    chat.add("operator", inbox);
    const blob = chat.serialize() + collect + JSON.stringify(inbox);
    assert.equal(transcriptContainsSecret(blob, CANARY), false, blob);
    const url = new URL(String(miss.collect_url));
    assert.equal(url.search, "");
  } finally {
    await http.close();
    await store.close();
    cleanup(home);
  }
});
