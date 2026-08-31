import { MCP_INSTRUCTIONS_LOCAL, MCP_SERVER_NAME } from "./brand.ts";
import { normalizeSecretName } from "./ids.ts";
import { assertSafePublicObject } from "./redact.ts";
import type { Vault } from "./vault.ts";
import type { GrantScope } from "./types.ts";

export const MCP_SERVER_INFO = {
  name: MCP_SERVER_NAME,
  version: "0.1.0",
} as const;

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const MCP_TOOL_NAMES = [
  "list_secrets",
  "request_grant",
  "list_grants",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

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
};

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "list_secrets",
    description:
      "List named secrets in the grant vault. Returns names, last-4, and timestamps only — never secret values.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "request_grant",
    description:
      "Ask the operator to grant a named secret to this agent for a named tool. Creates a pending grant. Never returns the secret value. The operator must approve via `vault grant` or the operator console.",
    inputSchema: {
      type: "object",
      properties: {
        secret_name: { type: "string", description: "Named secret, e.g. STRIPE_KEY" },
        agent_id: { type: "string", description: "Agent requesting the grant" },
        tool_id: { type: "string", description: "Tool/connector that will receive the inject" },
        scope: {
          type: "string",
          enum: ["once", "session"],
          description: "once = single inject; session = until revoke or TTL",
        },
      },
      required: ["secret_name", "agent_id", "tool_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_grants",
    description:
      "List grant status (pending/active/revoked/consumed). Names and metadata only — never secret values.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        tool_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

export type McpCallResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function listMcpTools(): McpToolDefinition[] {
  for (const tool of MCP_TOOLS) {
    if (FORBIDDEN_TOOL_NAMES.includes(tool.name)) {
      throw new Error(`Refusing forbidden MCP tool: ${tool.name}`);
    }
  }
  return MCP_TOOLS;
}

export function callMcpTool(
  vault: Vault,
  name: string,
  args: Record<string, unknown> = {},
): McpCallResult {
  if (FORBIDDEN_TOOL_NAMES.includes(name) || name.includes("value") || name.includes("decrypt") || name === "revoke_grant") {
    return fail(`Tool ${name} is not available. Vault MCP never returns secret values. Revoke is operator-only.`);
  }
  try {
    const payload = dispatch(vault, name, args);
    assertSafePublicObject(`mcp:${name}`, payload);
    const status =
      payload && typeof payload === "object" && "status" in payload
        ? (payload as { status: unknown }).status
        : undefined;
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      ...(status === "need_item" ? { isError: true } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}

function dispatch(vault: Vault, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "list_secrets":
      return {
        secrets: vault.listSecrets().map((s) => ({
          name: s.name,
          last4: s.last4,
          created_at: s.createdAt,
          updated_at: s.updatedAt,
        })),
      };
    case "request_grant": {
      const secretName = normalizeSecretName(str(args, "secret_name"));
      const known = vault.listSecrets().some((s) => s.name === secretName);
      if (!known) {
        return {
          status: "need_item",
          message:
            "No secret with that name. Store it with `vault store` or the local console. Do not paste the secret into chat.",
        };
      }
      return publicGrant(
        vault.requestGrant({
          secretName,
          agentId: str(args, "agent_id"),
          toolId: str(args, "tool_id"),
          scope: optionalScope(args.scope),
        }),
      );
    }
    case "list_grants": {
      let grants = vault.listGrants();
      if (typeof args.agent_id === "string") {
        grants = grants.filter((g) => g.agentId === args.agent_id);
      }
      if (typeof args.tool_id === "string") {
        grants = grants.filter((g) => g.toolId === args.tool_id);
      }
      return { grants: grants.map(publicGrant) };
    }
    default:
      throw new Error(
        `Unknown tool ${name}. Available: ${MCP_TOOL_NAMES.join(", ")}. There is no tool that reads secret values. Revoke is operator-only.`,
      );
  }
}

function publicGrant(grant: {
  id: string;
  secretName: string;
  agentId: string;
  toolId: string;
  scope: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
}) {
  return {
    grant_id: grant.id,
    secret_name: grant.secretName,
    agent_id: grant.agentId,
    tool_id: grant.toolId,
    scope: grant.scope,
    status: grant.status,
    expires_at: grant.expiresAt,
    created_at: grant.createdAt,
    approved_at: grant.approvedAt,
    revoked_at: grant.revokedAt,
  };
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
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

export function handleMcpRpc(vault: Vault, req: JsonRpcRequest): JsonRpcResponse | null {
  const id = req.id ?? null;
  const method = req.method ?? "";
  if (method.startsWith("notifications/")) return null;

  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_INSTRUCTIONS_LOCAL,
        });
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
        return ok(id, callMcpTool(vault, name, args));
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
