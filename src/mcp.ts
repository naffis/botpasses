/**
 * Local sqlite MCP JSON-RPC and tools. Public contract: docs/reference/mcp.md.
 * Same five tool names and argument shapes as hosted (3.8): `list_items`, `find_items`,
 * `request_grant`, `list_grants`, `http_request`. The agent id comes from the MCP client's
 * `initialize` `clientInfo.name`; grants are keyed (item, agent, tool) with tool `http_request`.
 * Never returns secret values. There is no get_secret.
 */
import { MCP_INSTRUCTIONS_LOCAL, MCP_SERVER_NAME } from "./brand.ts";
import type { ConnectorFetch } from "./hosted/connector.ts";
import { isHttpError } from "./hosted/errors.ts";
import { connectorTargetFromArgs, retryFields } from "./hosted/mcp-http.ts";
import { normalizeActorId, normalizeSecretName } from "./ids.ts";
import { assertSafePublicObject } from "./redact.ts";
import { HTTP_REQUEST_TOOL, publicLocalGrant, type Vault } from "./vault.ts";
import type { GrantScope } from "./types.ts";

export const MCP_SERVER_INFO = {
  name: MCP_SERVER_NAME,
  version: "0.2.0",
} as const;

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const MCP_TOOL_NAMES = [
  "list_items",
  "find_items",
  "request_grant",
  "list_grants",
  "http_request",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Old names accepted on `tools/call` for one release; never advertised. */
export const MCP_TOOL_ALIASES: Record<string, McpToolName> = {
  list_secrets: "list_items",
  "http.request": "http_request",
};

/** Agent id used when a client never sent `initialize` (stateless HTTP callers). */
export const DEFAULT_AGENT_ID = "mcp";

const FORBIDDEN_TOOL_NAMES = [
  "get_secret",
  "read_value",
  "read_secret",
  "reveal_secret",
  "decrypt_secret",
  "export_secret",
];

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: JsonSchema;
  annotations?: { title: string; readOnlyHint?: boolean; openWorldHint?: boolean; destructiveHint?: boolean };
};

const TASK_DESCRIPTION = { type: "string", description: "Short reason shown to the operator when they approve." };

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "list_items",
    description:
      "Inventory of named credentials in the local vault (names, last-4, hosts). Prefer http_request when the user wants an API called. Never returns values.",
    annotations: { title: "List stored credential names", readOnlyHint: true },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "find_items",
    description:
      "Look up a stored credential by exact API hostname or item_name. Prefer http_request (it finds for you). Never returns values. On need_item, tell the operator to run vault set.",
    annotations: { title: "Find a credential by API host" },
    inputSchema: {
      type: "object",
      properties: {
        item_name: { type: "string", description: "Exact stored credential name." },
        host: { type: "string", description: "Hostname of the API you need to call, such as api.example.com." },
        task_description: TASK_DESCRIPTION,
      },
      additionalProperties: false,
    },
  },
  {
    name: "request_grant",
    description:
      "Ask the operator to allow this agent to use a named credential with http_request. Creates a pending grant the operator approves with vault grant or the local console. Never returns the secret value.",
    annotations: { title: "Ask the operator to approve using a credential" },
    inputSchema: {
      type: "object",
      properties: {
        item_name: { type: "string", description: "Exact credential name, e.g. STRIPE_KEY" },
        task_id: { type: "string" },
        task_description: TASK_DESCRIPTION,
      },
      required: ["item_name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_grants",
    description:
      "Grant status for this agent (pending, active, revoked, consumed, expired). Names and metadata only, never secret values.",
    annotations: { title: "List grant status", readOnlyHint: true },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "http_request",
    description:
      "Primary tool. Call an allowlisted API with a stored credential attached by the vault. Pass host or item_name, method, and path (or a full https URL). Returns a redacted body, or need_item / a pending grant to retry after the operator approves. Never returns the secret.",
    annotations: { title: "Call an API with a Botpasses credential", openWorldHint: true, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        item_name: { type: "string", description: "Exact credential name, if you already have one." },
        host: { type: "string", description: "API hostname (api.example.com). Optional when item_name is set or path is a full https URL." },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTPS method." },
        path: { type: "string", description: "Path on the allowlisted origin (/v1/me) or a full https URL." },
        body: { type: "object", description: "Object body for POST, PUT, or PATCH. JSON by default." },
        content_type: { type: "string", enum: ["application/json", "application/x-www-form-urlencoded"] },
        task_description: TASK_DESCRIPTION,
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
  },
];

export type McpCallResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** One MCP connection. `agentId` is learned from `initialize` and keys this agent's grants. */
export type McpSession = { agentId: string | undefined };

export function newMcpSession(): McpSession {
  return { agentId: undefined };
}

export type McpCallContext = {
  session?: McpSession;
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
};

/** `clientInfo.name` is free text; keep the letters, digits, `_` and `-` so it fits the actor grammar. */
export function agentIdFromClientName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const compact = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 128);
  return compact ? normalizeActorId(compact, "agent") : DEFAULT_AGENT_ID;
}

export function listMcpTools(): McpToolDefinition[] {
  for (const tool of MCP_TOOLS) {
    if (FORBIDDEN_TOOL_NAMES.includes(tool.name)) {
      throw new Error(`Refusing forbidden MCP tool: ${tool.name}`);
    }
  }
  return MCP_TOOLS;
}

export async function callMcpTool(
  vault: Vault,
  name: string,
  args: Record<string, unknown> = {},
  ctx: McpCallContext = {},
): Promise<McpCallResult> {
  if (FORBIDDEN_TOOL_NAMES.includes(name) || name.includes("value") || name.includes("decrypt") || name === "revoke_grant") {
    return fail(`Tool ${name} is not available. Vault MCP never returns secret values. Revoke is operator-only.`);
  }
  const canonical = MCP_TOOL_ALIASES[name] ?? name;
  try {
    const payload = await dispatch(vault, canonical, args, ctx);
    assertSafePublicObject(`mcp:${name}`, payload);
    const status = payload && typeof payload === "object" && "status" in payload ? payload.status : undefined;
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      ...(status === "need_item" || status === "host_mismatch" ? { isError: true } : {}),
    };
  } catch (err) {
    if (isHttpError(err) && err.extra.status === "host_mismatch") {
      const payload = { error: err.message, ...err.extra };
      assertSafePublicObject(`mcp:${name}`, payload);
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}

function agentFor(args: Record<string, unknown>, ctx: McpCallContext): string {
  // `agent_id` is the pre-3.8 argument; still honoured for one release.
  if (typeof args.agent_id === "string" && args.agent_id.trim()) return normalizeActorId(args.agent_id, "agent");
  return ctx.session?.agentId ?? DEFAULT_AGENT_ID;
}

function toolFor(args: Record<string, unknown>): string {
  if (typeof args.tool_id === "string" && args.tool_id.trim()) return normalizeActorId(args.tool_id, "tool");
  return HTTP_REQUEST_TOOL;
}

function publicItem(m: { name: string; last4: string; allowedHosts: string[]; inject: string }) {
  return { name: m.name, kind: "secret", last4: m.last4, username: null, environment: "local", inject: m.inject, allowed_hosts: m.allowedHosts };
}

function itemSummary(m: { name: string; last4: string; allowedHosts: string[]; inject: string }) {
  return { name: m.name, kind: "secret", last4: m.last4, allowed_hosts: m.allowedHosts, inject: m.inject, environment: "local" };
}

function needItem(itemName: string | undefined, host: string | undefined): Record<string, unknown> {
  const suggested = itemName ? normalizeSecretName(itemName) : "API_KEY";
  return {
    status: "need_item",
    suggested_name: suggested,
    host: host ?? "",
    message: `No credential${host ? ` for ${host}` : ""}. Store it with: vault set ${suggested}${host ? ` --host ${host}` : ""}. Do not paste the secret into chat.`,
  };
}

async function dispatch(vault: Vault, name: string, args: Record<string, unknown>, ctx: McpCallContext): Promise<unknown> {
  switch (name) {
    case "list_items":
      return { items: vault.listItems().map(publicItem) };
    case "find_items": {
      const itemName = optionalString(args.item_name);
      const host = optionalString(args.host)?.trim().toLowerCase();
      if (itemName) {
        const item = vault.getItem(itemName);
        if (!item) return needItem(itemName, host);
        if (host && !item.allowedHosts.includes(host)) return { status: "host_mismatch", item: itemSummary(item) };
        return { status: "found", item: itemSummary(item) };
      }
      if (host) {
        const matches = vault.findItemsByHost(host);
        if (matches.length === 1 && matches[0]) return { status: "found", item: itemSummary(matches[0]) };
        if (matches.length > 1) return { status: "ambiguous", items: matches.slice(0, 5).map(itemSummary), truncated: matches.length > 5 };
        return needItem(undefined, host);
      }
      return { items: [] };
    }
    case "request_grant": {
      const rawName = optionalString(args.item_name) ?? optionalString(args.secret_name);
      if (!rawName) throw new Error("Missing required string argument: item_name");
      const itemName = normalizeSecretName(rawName);
      if (!vault.getItem(itemName)) return needItem(itemName, undefined);
      const grant = vault.requestGrant({
        secretName: itemName,
        agentId: agentFor(args, ctx),
        toolId: toolFor(args),
        scope: optionalScope(args.scope),
      });
      return {
        ...publicLocalGrant(grant),
        task_id: optionalString(args.task_id) ?? null,
        task_description: optionalString(args.task_description) ?? null,
        message: `Approve with: vault grant --secret ${grant.secretName} --agent ${grant.agentId} --tool ${grant.toolId} --once (or --session), or in the local console.`,
      };
    }
    case "list_grants": {
      const agentId = agentFor(args, ctx);
      const toolId = typeof args.tool_id === "string" && args.tool_id.trim() ? normalizeActorId(args.tool_id, "tool") : undefined;
      const grants = vault
        .listGrants()
        .filter((g) => g.agentId === agentId && (toolId === undefined || g.toolId === toolId));
      return { grants: grants.map(publicLocalGrant) };
    }
    case "http_request": {
      const target = connectorTargetFromArgs(args);
      const result = await vault.httpRequest({
        agentId: agentFor(args, ctx),
        toolId: toolFor(args),
        itemName: target.itemName,
        host: target.host,
        method: target.method,
        path: target.path,
        body: args.body,
        contentType: target.contentType,
        taskDescription: target.taskDescription,
        fetchImpl: ctx.fetchImpl,
        resolveAddresses: ctx.resolveAddresses,
      });
      const itemName = "item_name" in result && typeof result.item_name === "string" ? result.item_name : target.itemName;
      return { ...result, retry: retryFields(target, itemName) };
    }
    default:
      throw new Error(
        `Unknown tool ${name}. Available: ${MCP_TOOL_NAMES.join(", ")}. There is no tool that reads secret values. Revoke is operator-only.`,
      );
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalScope(value: unknown): GrantScope | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "once" || value === "session") return value;
  throw new Error("scope must be once or session");
}

function fail(message: string): McpCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

/** `session` is per connection; the stdio runner and the loopback server each hold one. */
export async function handleMcpRpc(
  vault: Vault,
  req: JsonRpcRequest,
  session: McpSession = newMcpSession(),
  ctx: Omit<McpCallContext, "session"> = {},
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const method = req.method ?? "";
  if (method.startsWith("notifications/")) return null;

  try {
    switch (method) {
      case "initialize": {
        const info = req.params?.clientInfo;
        if (info && typeof info === "object") session.agentId = agentIdFromClientName((info as { name?: unknown }).name);
        return ok(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_INSTRUCTIONS_LOCAL,
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: listMcpTools() });
      case "tools/call": {
        const params = req.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        const args =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        return ok(id, await callMcpTool(vault, name, args, { ...ctx, session }));
      }
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { jsonrpc: "2.0", id, error: { code: -32000, message } };
  }
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
