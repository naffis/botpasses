import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { callMcpTool, handleMcpRpc, listMcpTools } from "../src/mcp.ts";
import { transcriptContainsSecret } from "../src/redact.ts";
import { dbPath } from "../src/db.ts";
import { CANARY, ChatTranscript, cleanup, makeVault } from "./helpers.ts";

test("mocked LLM/agent conversation never contains the stored secret after store, grant, or use", async () => {
  const { vault, home } = makeVault();
  const chat = new ChatTranscript();

  try {
    const stored = vault.setSecret("STRIPE_KEY", CANARY);
    chat.add(
      "operator",
      `Stored named secret ${stored.name} last4=${stored.last4}. Value is not shown again.`,
    );

    const listSecrets = callMcpTool(vault, "list_secrets", {});
    chat.add("agent", { tool: "list_secrets", result: listSecrets });

    const requested = callMcpTool(vault, "request_grant", {
      secret_name: "STRIPE_KEY",
      agent_id: "invoicer",
      tool_id: "stripe",
      scope: "once",
    });
    chat.add("agent", { tool: "request_grant", result: requested });

    const grant = vault.approveGrant({
      secretName: "STRIPE_KEY",
      agentId: "invoicer",
      toolId: "stripe",
      scope: "once",
    });
    chat.add(
      "operator",
      `Approved grant ${grant.id} secret=${grant.secretName} tool=${grant.toolId} agent=${grant.agentId} scope=${grant.scope}. Value not shown.`,
    );

    const listedGrants = callMcpTool(vault, "list_grants", {});
    chat.add("agent", { tool: "list_grants", result: listedGrants });

    const tools = handleMcpRpc(vault, { jsonrpc: "2.0", id: 2, method: "tools/list" });
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

    const revoked = callMcpTool(vault, "revoke_grant", { grant_id: grant.id });
    chat.add("agent", { tool: "revoke_grant", result: revoked });

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
