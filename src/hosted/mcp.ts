/**
 * Hosted MCP JSON-RPC and tools. Public contract: docs/reference/mcp.md.
 * Never returns secret values. There is no get_secret.
 */
import { MCP_SERVER_NAME } from "../brand.ts";
import { packageVersion } from "./observe.ts";
import {
  HOSTED_TOOL_DESCRIPTIONS,
  HOSTED_TOOL_PARAM_DESCRIPTIONS,
  MCP_INSTRUCTIONS_HOSTED,
} from "../prompts/mcp-hosted.ts";
import { assertSafePublicObject } from "../redact.ts";
import {
  publicGrantScope,
  type HostedGrantRecord,
  type ItemPublic,
  type VaultEnvName,
} from "../hosted-types.ts";
import type { ConnectorFetch } from "./connector.ts";
import { HttpError, isHttpError, isNeedItemError } from "./errors.ts";
import type { HostedKernel } from "./kernel.ts";
import type { ModelPrincipal } from "./auth.ts";
import { runHttpRequest } from "./mcp-http.ts";
import { attachMcpNext } from "./mcp-steer.ts";

export const HOSTED_MCP_SERVER_INFO = {
  name: MCP_SERVER_NAME,
  version: packageVersion(),
} as const;

export const HOSTED_MCP_PROTOCOL = "2024-11-05";

export const HOSTED_MCP_TOOL_NAMES = [
  "list_items",
  "find_items",
  "request_grant",
  "list_grants",
  "http_request",
] as const;

/**
 * Old name of `http_request`. Hosts with `^[a-zA-Z0-9_-]+$` tool-name grammars rejected the dot.
 * Accepted on `tools/call` for one release; never advertised.
 */
export const HOSTED_MCP_TOOL_ALIASES: Record<string, (typeof HOSTED_MCP_TOOL_NAMES)[number]> = {
  "http.request": "http_request",
};

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
  annotations?: {
    title: string;
    readOnlyHint?: boolean;
    openWorldHint?: boolean;
    destructiveHint?: boolean;
  };
};

export const HOSTED_MCP_TOOLS: HostedMcpTool[] = [
  {
    name: "list_items",
    description: HOSTED_TOOL_DESCRIPTIONS.list_items,
    annotations: { title: "List stored credential names", readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "find_items",
    // Optional: http_request finds the item itself. Kept for hosts that want to look before calling.
    // Not readOnlyHint: a miss records a need row the operator sees in the inbox.
    description: `Optional. ${HOSTED_TOOL_DESCRIPTIONS.find_items}`,
    annotations: { title: "Find a credential by API host (optional)" },
    inputSchema: {
      type: "object",
      properties: {
        item_name: { type: "string", description: HOSTED_TOOL_PARAM_DESCRIPTIONS.find_item_name },
        host: { type: "string", description: HOSTED_TOOL_PARAM_DESCRIPTIONS.find_host },
        task_description: {
          type: "string",
          description: HOSTED_TOOL_PARAM_DESCRIPTIONS.find_task_description,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "request_grant",
    description: HOSTED_TOOL_DESCRIPTIONS.request_grant,
    annotations: { title: "Ask the operator to approve using a credential" },
    inputSchema: {
      type: "object",
      properties: {
        item_name: { type: "string", description: HOSTED_TOOL_PARAM_DESCRIPTIONS.grant_item_name },
        task_id: { type: "string" },
        task_description: {
          type: "string",
          description: HOSTED_TOOL_PARAM_DESCRIPTIONS.grant_task_description,
        },
        host: {
          type: "string",
          description:
            "API hostname the call will go to (api.stripe.com). Must be one of the item's allowed hosts. Shown to the operator; a one-click approval is limited to it.",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTPS method the call will use. Shown to the operator; a one-click approval is limited to it.",
        },
        path: {
          type: "string",
          description:
            "Path the call will use (/v1/balance). Shown to the operator; a one-click approval is limited to paths under it.",
        },
      },
      required: ["item_name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_grants",
    description: HOSTED_TOOL_DESCRIPTIONS.list_grants,
    annotations: { title: "List grant status", readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "http_request",
    description: HOSTED_TOOL_DESCRIPTIONS.http_request,
    annotations: {
      title: "Call an API with a Botpasses credential",
      openWorldHint: true,
      destructiveHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        item_name: { type: "string", description: HOSTED_TOOL_PARAM_DESCRIPTIONS.http_item_name },
        host: { type: "string", description: HOSTED_TOOL_PARAM_DESCRIPTIONS.http_host },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: HOSTED_TOOL_PARAM_DESCRIPTIONS.http_method,
        },
        path: { type: "string", description: HOSTED_TOOL_PARAM_DESCRIPTIONS.http_path },
        body: { type: "object", description: HOSTED_TOOL_PARAM_DESCRIPTIONS.http_body },
        content_type: {
          type: "string",
          enum: ["application/json", "application/x-www-form-urlencoded"],
          description: HOSTED_TOOL_PARAM_DESCRIPTIONS.http_content_type,
        },
        client_id: { type: "string", description: HOSTED_TOOL_PARAM_DESCRIPTIONS.http_client_id },
        task_description: {
          type: "string",
          description: HOSTED_TOOL_PARAM_DESCRIPTIONS.find_task_description,
        },
        timeout_ms: {
          type: "number",
          minimum: 1000,
          maximum: 30000,
          description: HOSTED_TOOL_PARAM_DESCRIPTIONS.http_timeout_ms,
        },
        dry_run: { type: "boolean", description: HOSTED_TOOL_PARAM_DESCRIPTIONS.http_dry_run },
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

export type HostedMcpDeps = {
  kernel: HostedKernel;
  principal: ModelPrincipal;
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
};

/** Public grant fields on MCP results. `grant_scope` is null when the grant is unrestricted. */
export function publicGrant(g: HostedGrantRecord) {
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
    requested_scope: g.requestedScope,
    grant_scope: publicGrantScope(g),
  };
}

/** Environment is the client's binding. An `environment` argument is accepted and ignored. */
function envOf(principal: ModelPrincipal): VaultEnvName {
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
  const canonical = HOSTED_MCP_TOOL_ALIASES[name] ?? name;
  try {
    const payload = attachMcpNext(await dispatch(deps, canonical, args));
    assertSafePublicObject(`mcp:${name}`, payload);
    return mcpPayloadResult(payload);
  } catch (err) {
    if (isNeedItemError(err)) {
      const payload = attachMcpNext(err.payload);
      assertSafePublicObject(`mcp:${name}`, payload);
      return mcpPayloadResult(payload);
    }
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
  const environment = envOf(principal);
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
          allowed_hosts: i.allowedHosts,
        })),
      };
    }
    case "find_items": {
      const itemName = optional(args.item_name);
      const host = optional(args.host);
      return kernel.findItems({
        orgId: principal.orgId,
        clientId: principal.clientId,
        environment,
        itemName,
        host,
        taskDescription: optional(args.task_description),
      });
    }
    case "request_grant": {
      const itemName = str(args, "item_name");
      const host = optional(args.host);
      const method = optional(args.method);
      const path = optional(args.path);
      const result = await kernel.requestGrant({
        orgId: principal.orgId,
        clientId: principal.clientId,
        itemName,
        environment,
        taskId: optional(args.task_id),
        taskDescription: optional(args.task_description),
        request: host || method || path ? { host, method, path } : undefined,
      });
      return {
        ...publicGrant(result.grant),
        item_name: itemName,
        approval_code: result.code,
        notify_failed: result.notifyFailed ?? false,
      };
    }
    case "list_grants": {
      const grants = await kernel.listClientGrants(principal.orgId, principal.clientId);
      return { grants: grants.map(publicGrant) };
    }
    case "http_request": {
      return runHttpRequest(deps, args, environment);
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

function mcpPayloadResult(payload: unknown): McpCallResult {
  const status =
    payload && typeof payload === "object" && "status" in payload
      ? payload.status
      : undefined;
  const blocking = status === "host_mismatch";
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(blocking ? { isError: true } : {}),
  };
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

export function isMcpHandshakeMethod(method?: string): boolean {
  if (!method) return false;
  return (
    method === "initialize" ||
    method === "ping" ||
    method === "tools/list" ||
    method.startsWith("notifications/")
  );
}

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
