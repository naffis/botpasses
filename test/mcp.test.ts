import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_TOOL_NAMES,
  callMcpTool,
  handleMcpRpc,
  listMcpTools,
} from "../src/mcp.ts";
import { CANARY, cleanup, makeVault } from "./helpers.ts";

test("MCP advertises only name/grant tools — never a read_value tool", () => {
  const tools = listMcpTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...MCP_TOOL_NAMES].sort(),
  );
  for (const tool of tools) {
    assert.doesNotMatch(tool.name, /value|decrypt|reveal|read_secret|get_secret/);
    assert.match(tool.description, /never/i);
  }
});

test("MCP tools/call never returns the stored value", () => {
  const { vault, home } = makeVault();
  try {
    vault.setSecret("STRIPE_KEY", CANARY);
    const listed = callMcpTool(vault, "list_secrets", {});
    const requested = callMcpTool(vault, "request_grant", {
      secret_name: "STRIPE_KEY",
      agent_id: "invoicer",
      tool_id: "stripe",
      scope: "once",
    });
    const grants = callMcpTool(vault, "list_grants", {});
    const blob = JSON.stringify({ listed, requested, grants });
    assert.ok(!blob.includes(CANARY));
    assert.match(listed.content[0]?.text ?? "", /STRIPE_KEY/);
    assert.match(listed.content[0]?.text ?? "", /c10b/);
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("MCP get_secret / read_value are rejected", () => {
  const { vault, home } = makeVault();
  try {
    vault.setSecret("STRIPE_KEY", CANARY);
    for (const name of ["get_secret", "read_value", "reveal_secret", "decrypt_secret"]) {
      const result = callMcpTool(vault, name, { name: "STRIPE_KEY" });
      assert.equal(result.isError, true);
      assert.ok(!(result.content[0]?.text ?? "").includes(CANARY));
    }
    const rpc = handleMcpRpc(vault, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_secret", arguments: { name: "STRIPE_KEY" } },
    });
    assert.ok(rpc);
    assert.ok(!JSON.stringify(rpc).includes(CANARY));
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("request_grant leaves the grant pending — MCP cannot self-approve", () => {
  const { vault, home } = makeVault();
  try {
    vault.setSecret("STRIPE_KEY", CANARY);
    const result = callMcpTool(vault, "request_grant", {
      secret_name: "STRIPE_KEY",
      agent_id: "invoicer",
      tool_id: "stripe",
    });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { status?: string };
    assert.equal(parsed.status, "pending");
    assert.equal(vault.listGrants()[0]?.status, "pending");
  } finally {
    vault.close();
    cleanup(home);
  }
});
