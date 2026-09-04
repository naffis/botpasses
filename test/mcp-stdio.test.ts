/**
 * JSON-RPC framing on the stdio MCP server. A frame that is not a request object (a bare
 * null, number, string, or array) or has no method must be answered, not crash the process:
 * one bad line from a client would otherwise end the whole MCP connection with exit 1.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateMasterKey } from "../src/crypto.ts";
import { parseFrame } from "../src/mcp-stdio.ts";
import { cleanup, tempHome } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

type Rpc = { id: string | number | null; result?: unknown; error?: { code: number; message: string } };

test("parseFrame answers non-object frames with -32600 and bad JSON with -32700", () => {
  for (const line of ["null", "42", '"ping"', "[]", "true"]) {
    const frame = parseFrame(line);
    assert.ok("err" in frame, line);
    assert.equal(frame.err.error?.code, -32600, line);
    assert.equal(frame.err.id, null, line);
  }
  const bad = parseFrame("{not json");
  assert.ok("err" in bad);
  assert.equal(bad.err.error?.code, -32700);
  const ok = parseFrame('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert.ok("req" in ok);
  assert.equal(ok.req.method, "ping");
});

test("stdio MCP server answers malformed frames and still serves the ping that follows", async () => {
  const home = tempHome();
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, "mcp"],
    { env: { ...process.env, VAULT_HOME: home, VAULT_MASTER_KEY: generateMasterKey() }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    stdout += c;
  });
  child.stderr.on("data", (c: string) => {
    stderr += c;
  });
  const frames = [
    "null",
    "[]",
    '"ping"',
    '{"jsonrpc":"2.0","id":7}',
    "{not json}",
    '{"jsonrpc":"2.0","id":9,"method":"ping"}',
  ];
  try {
    child.stdin.write(`${frames.join("\n")}\n`);
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    const answers = stdout.trim().split("\n").map((l) => JSON.parse(l) as Rpc);
    assert.equal(answers.length, frames.length, stdout);
    assert.deepEqual(
      answers.slice(0, 3).map((a) => [a.id, a.error?.code]),
      [
        [null, -32600],
        [null, -32600],
        [null, -32600],
      ],
    );
    assert.deepEqual([answers[3]?.id, answers[3]?.error?.code], [7, -32600], "a frame without a method is an invalid request, not an unknown method");
    assert.deepEqual([answers[4]?.id, answers[4]?.error?.code], [null, -32700]);
    assert.equal(answers[5]?.id, 9);
    assert.deepEqual(answers[5]?.result, {}, "the ping after the bad frames is answered");
  } finally {
    cleanup(home);
  }
});
