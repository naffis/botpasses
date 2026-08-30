import { MCP_INSTRUCTIONS_HOSTED, MCP_SERVER_NAME } from "../brand.ts";
import { assertSafePublicObject } from "../redact.ts";
import type { HostedGrantRecord, ItemPublic, VaultEnvName } from "../hosted-types.ts";
import { executeConnector, type ConnectorFetch } from "./connector.ts";
import { HttpError, isHttpError } from "./errors.ts";
import type { HostedKernel } from "./kernel.ts";
import type { ModelPrincipal } from "./auth.ts";

export const HOSTED_MCP_SERVER_INFO = {
  name: MCP_SERVER_NAME,
  version: "0.2.0",
} as const;

export const HOSTED_MCP_PROTOCOL = "2024-11-05";

export const HOSTED_MCP_TOOL_NAMES = [
  "list_items",
  "request_grant",
  "list_grants",
  "http.request",
] as const;

const FORBIDDEN = ["get_secret", "read_value", "read_secret", "reveal_secret", "decrypt_secret", "revoke_grant"];

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type HostedMcpTool = {
  name: (typeof HOSTED_MCP_TOOL_NAMES)[number];
  description: string;
  inputSchema: JsonSchema;
};

export const HOSTED_MCP_TOOLS: HostedMcpTool[] = [
  {
    name: "list_items",
    description:
      "List named vault items. Returns names, last-4, username, environment — never concealed values.",
    inputSchema: {
      type: "object",
      properties: {
        environment: { type: "string", enum: ["staging", "production"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "request_grant",
    description:
      "Ask the operator to grant a named item to this client. Returns pending or already-active grant metadata and an 8-digit code when pending. Never returns the secret value.",
    inputSchema: {
      type: "object",
      properties: {
        item_name: { type: "string" },
        environment: { type: "string", enum: ["staging", "production"] },
        task_id: { type: "string" },
        task_description: { type: "string" },
      },
      required: ["item_name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_grants",
    description: "List grant status for this client. Names and metadata only — never secret values.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "http.request",
    description:
      "Call the item's allowlisted HTTPS origin with the granted credential attached. Returns status and a redacted body. Never returns the secret.",
    inputSchema: {
      type: "object",
      properties: {
        item_name: { type: "string" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string" },
        body: { type: "object" },
        environment: { type: "string", enum: ["staging", "production"] },
      },
      required: ["item_name", "method", "path"],
      additionalProperties: false,
    },
  },
];

export type McpCallResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export type HostedMcpDeps = {
  kernel: HostedKernel;
  principal: ModelPrincipal;
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
};

function publicGrant(g: HostedGrantRecord) {
  return {
    grant_id: g.id,
    policy: g.policy,
    status: g.status,
    environment_id: g.environmentId,
    expires_at: g.expiresAt,
    created_at: g.createdAt,
    approved_at: g.approvedAt,
    consumed_at: g.consumedAt,
    task_id: g.taskId,
    task_description: g.taskDescription,
  };
}

function envOf(principal: ModelPrincipal, _args: Record<string, unknown>): VaultEnvName {
  return principal.environment;
}

export function listHostedMcpTools(): HostedMcpTool[] {
  for (const t of HOSTED_MCP_TOOLS) {
    if (FORBIDDEN.includes(t.name)) throw new Error(`Forbidden tool ${t.name}`);
  }
  return HOSTED_MCP_TOOLS;
}

export async function callHostedMcpTool(
  deps: HostedMcpDeps,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpCallResult> {
  if (FORBIDDEN.includes(name) || name.includes("value") || name.includes("decrypt")) {
    return fail(`Tool ${name} is not available. Vault MCP never returns secret values.`);
  }
  try {
    const payload = await dispatch(deps, name, args);
    assertSafePublicObject(`mcp:${name}`, payload);
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  } catch (err) {
    const message = isHttpError(err) ? err.message : err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}

async function dispatch(
  deps: HostedMcpDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { kernel, principal } = deps;
  const environment = envOf(principal, args);
  switch (name) {
    case "list_items": {
      const items: ItemPublic[] = await kernel.listItems(principal.orgId, environment);
      return {
        items: items.map((i) => ({
          name: i.name,
          kind: i.kind,
          last4: i.last4,
          username: i.username,
          environment: i.environment,
          inject: i.inject,
        })),
      };
    }
    case "request_grant": {
      const itemName = str(args, "item_name");
      const result = await kernel.requestGrant({
        orgId: principal.orgId,
        clientId: principal.clientId,
        itemName,
        environment,
        taskId: optional(args.task_id),
        taskDescription: optional(args.task_description),
      });
      return {
        ...publicGrant(result.grant),
        approval_code: result.code,
        notify_failed: result.notifyFailed ?? false,
      };
    }
    case "list_grants": {
      const grants = await kernel.listClientGrants(principal.orgId, principal.clientId);
      return { grants: grants.map(publicGrant) };
    }
    case "http.request": {
      const itemName = str(args, "item_name");
      const method = str(args, "method");
      const path = str(args, "path");
      const prepared = await kernel.prepareConnector({
        orgId: principal.orgId,
        clientId: principal.clientId,
        itemName,
        environment,
      });
      const origin = await executeConnector(
        prepared,
        { method, path, body: args.body },
        { fetchImpl: deps.fetchImpl, resolveAddresses: deps.resolveAddresses },
      );
      return { status: origin.status, body: origin.body };
    }
    default:
      throw new HttpError(
        400,
        `Unknown tool ${name}. Available: ${HOSTED_MCP_TOOL_NAMES.join(", ")}. There is no tool that reads secret values.`,
      );
  }
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Missing required string argument: ${key}`);
  }
  return value;
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

export async function handleHostedMcpRpc(
  deps: HostedMcpDeps,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const method = req.method ?? "";
  if (method.startsWith("notifications/")) return null;
  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: HOSTED_MCP_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: HOSTED_MCP_SERVER_INFO,
          instructions: MCP_INSTRUCTIONS_HOSTED,
        });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: listHostedMcpTools() });
      case "tools/call": {
        const params = req.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        const args =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        return ok(id, await callHostedMcpTool(deps, name, args));
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { jsonrpc: "2.0", id, error: { code: -32000, message } };
  }
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
