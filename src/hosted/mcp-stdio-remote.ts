import { createInterface } from "node:readline";

/**
 * Hosted stdio MCP: forward JSON-RPC lines to the remote vault with the operator JWT.
 * Never put CLERK_SECRET_KEY in mcp.json.
 */
export async function runRemoteMcpStdio(opts: {
  publicUrl: string;
  userJwt: string;
}): Promise<void> {
  const endpoint = `${opts.publicUrl.replace(/\/$/, "")}/mcp`;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.userJwt}`,
      },
      body: trimmed,
    });
    const text = await res.text();
    if (text) process.stdout.write(`${text.endsWith("\n") ? text : `${text}\n`}`);
  }
}
