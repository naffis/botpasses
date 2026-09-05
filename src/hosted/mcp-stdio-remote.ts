import { createInterface } from "node:readline";

export const MCP_SESSION_HEADER = "mcp-session-id";

/**
 * Remote stdio MCP: forward JSON-RPC lines to `POST /mcp` over HTTP. The bearer is the loopback
 * model bearer (`vault mcp --remote`) or a hosted access token (`vault mcp --user-jwt`). A server
 * that answers `initialize` with `Mcp-Session-Id` (the loopback `vault serve`) gets that id back
 * on every later request, so this stdio connection stays one session on the other side.
 */
export async function runRemoteMcpStdio(opts: {
  publicUrl: string;
  userJwt: string;
}): Promise<void> {
  const endpoint = `${opts.publicUrl.replace(/\/$/, "")}/mcp`;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let sessionId: string | undefined;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.userJwt}`,
        ...(sessionId ? { [MCP_SESSION_HEADER]: sessionId } : {}),
      },
      body: trimmed,
    });
    const issued = res.headers.get(MCP_SESSION_HEADER);
    if (issued) sessionId = issued;
    const text = await res.text();
    if (text) process.stdout.write(`${text.endsWith("\n") ? text : `${text}\n`}`);
  }
}
