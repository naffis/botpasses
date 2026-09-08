import assert from "node:assert/strict";
import { test } from "node:test";
import { MCP_INSTRUCTIONS_HOSTED } from "../src/brand.ts";
import { handleHostedMcpRpc, listHostedMcpTools } from "../src/hosted/mcp.ts";
import { HOSTED_TOOL_DESCRIPTIONS } from "../src/prompts/mcp-hosted.ts";

test("hosted initialize instructions tell the model to act without a ritual prompt", () => {
  assert.match(MCP_INSTRUCTIONS_HOSTED, /does not need to say Botpasses/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /http_request/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /same turn/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /Do not list_items or find_items first/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /call setup with provider or host/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /user asks for their profile on an API/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /https:\/\/api\.example\.com\/v1\/me/);
  assert.doesNotMatch(MCP_INSTRUCTIONS_HOSTED, /spotify\.com/i);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /There is no get_secret/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /next\.for_model/);
  assert.match(MCP_INSTRUCTIONS_HOSTED, /next\.arguments/);
});

test("hosted tool descriptions make http.request the primary call", () => {
  const tools = Object.fromEntries(listHostedMcpTools().map((t) => [t.name, t]));
  assert.equal(tools.http_request?.description, HOSTED_TOOL_DESCRIPTIONS.http_request);
  assert.match(tools.http_request?.description ?? "", /Primary tool/);
  assert.match(tools.http_request?.description ?? "", /full https URL/);
  assert.match(tools.http_request?.description ?? "", /same turn/);
  assert.match(tools.find_items?.description ?? "", /Do not call this first/);
  const required = tools.http_request?.inputSchema.required ?? [];
  assert.deepEqual(required, ["method", "path"]);
  assert.ok(tools.http_request?.inputSchema.properties.host);
  assert.equal(tools.http_request?.annotations?.destructiveHint, true);
  for (const tool of listHostedMcpTools()) {
    assert.equal("environment" in tool.inputSchema.properties, false, `${tool.name} still advertises environment`);
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/, `${tool.name} is not a portable tool name`);
    assert.doesNotMatch(tool.description, /http[.]request/, `${tool.name} description names the old tool`);
  }
  assert.doesNotMatch(MCP_INSTRUCTIONS_HOSTED, /http[.]request/);
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
  const http = tools.find((t) => t.name === "http_request");
  assert.match(http?.description ?? "", /Primary tool/);
});
