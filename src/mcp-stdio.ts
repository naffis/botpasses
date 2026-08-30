import { createInterface } from "node:readline";
import { handleMcpRpc, type JsonRpcRequest } from "./mcp.ts";
import type { Vault } from "./vault.ts";

export async function runMcpStdio(vault: Vault): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const err = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
      process.stdout.write(`${JSON.stringify(err)}\n`);
      continue;
    }
    const res = handleMcpRpc(vault, req);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  }
}
