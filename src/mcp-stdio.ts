import { createInterface } from "node:readline";
import { handleMcpRpc, newMcpSession, type JsonRpcRequest, type JsonRpcResponse } from "./mcp.ts";
import type { Vault } from "./vault.ts";

function frameError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function idOf(req: JsonRpcRequest): string | number | null {
  return typeof req.id === "string" || typeof req.id === "number" ? req.id : null;
}

/**
 * One stdio line as a JSON-RPC request. Anything that is not a JSON object (a bare `null`,
 * number, string, or an array) is answered with -32600 and never reaches the handler, so a
 * malformed frame cannot end the connection.
 */
export function parseFrame(line: string): { req: JsonRpcRequest } | { err: JsonRpcResponse } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { err: frameError(null, -32700, "Parse error") };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { err: frameError(null, -32600, "Invalid Request: expected a JSON-RPC request object") };
  }
  return { req: value };
}

export async function runMcpStdio(vault: Vault): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // One process is one MCP connection: `initialize` names the agent for every later call.
  const session = newMcpSession();
  const write = (res: JsonRpcResponse): void => {
    process.stdout.write(`${JSON.stringify(res)}\n`);
  };
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const frame = parseFrame(trimmed);
    if ("err" in frame) {
      write(frame.err);
      continue;
    }
    let res: JsonRpcResponse | null;
    try {
      res = await handleMcpRpc(vault, frame.req, session);
    } catch {
      // handleMcpRpc answers its own dispatch errors; this is the last guard so the loop, and
      // with it the MCP connection, survives whatever one frame throws. No message: an
      // unexpected error text is not something to hand to the model.
      res = frameError(idOf(frame.req), -32603, "Internal error");
    }
    if (res) write(res);
  }
}
