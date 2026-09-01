import assert from "node:assert/strict";
import { test } from "node:test";
import { MCP_INSTRUCTIONS_HOSTED } from "../src/brand.ts";
import { handleHostedMcpRpc, listHostedMcpTools } from "../src/hosted/mcp.ts";
import { HOSTED_TOOL_DESCRIPTIONS } from "../src/prompts/mcp-hosted.ts";

test("hosted initialize instructions tell the model to act without a ritual prompt", () => {
  assert.match(MCP_INSTRUCTIONS_HOSTED, /does not need to say Botpasses/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /http\.request/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /same turn/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /Do not list_items or find_items first/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /get my Spotify profile/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /https:\/\/api\.spotify\.com\/v1\/me/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /There is no get_secret/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /next\.for_model/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /next\.arguments/);
});

test("hosted tool descriptions make http.request the primary call", () => {
  const tools = Object.fromEntries(listHostedMcpTools().map((t) => [t.name, t]));
  assert.equal(tools["http.request"]?.description, HOSTED_TOOL_DESCRIPTIONS["http.request"]);
  assert.match(tools["http.request"]?.description ?? "", /Primary tool/);
  assert.match(tools["http.request"]?.description ?? "", /full https URL/);
  assert.match(tools["http.request"]?.description ?? "", /same turn/);
  assert.match(tools.find_items?.description ?? "", /Do not call this first/);
  const required = tools["http.request"]?.inputSchema.required ?? [];
  assert.deepEqual(required, ["method", "path"]);
  assert.ok(tools["http.request"]?.inputSchema.properties.host);
});

test("tools/list RPC returns the steering descriptions", async () => {
  const rpc = await handleHostedMcpRpc(
    {
      kernel: {} as never,
      principal: {
        channel: "model",
        orgId: "org",
        clientId: "cli",
        environment: "staging",
      },
    },
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  );
  const tools = (rpc?.result as { tools?: { name: string; description: string }[] })?.tools ?? [];
  const http = tools.find((t) => t.name === "http.request");
  assert.match(http?.description ?? "", /Primary tool/);
});
