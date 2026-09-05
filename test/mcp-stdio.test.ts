/**
 * JSON-RPC framing on the stdio MCP server. A frame that is not a request object (a bare
 * null, number, string, or array) or has no method must be answered, not crash the process:
 * one bad line from a client would otherwise end the whole MCP connection with exit 1.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { parseFrame } from "../src/mcp-stdio.ts";
import { createVaultServer } from "../src/server.ts";
import { Vault } from "../src/vault.ts";
import { cleanup, tempHome } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

type Rpc = { id: string | number | null; result?: unknown; error?: { code: number; message: string } };

function runCli(args: string[], env: NodeJS.ProcessEnv, input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args],
    { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
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
  child.stdin.write(input);
  child.stdin.end();
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

test("R2-3: vault mcp --remote carries the Mcp-Session-Id that vault serve issued on initialize", async () => {
  const home = tempHome();
  const masterKey = generateMasterKey();
  const vault = new Vault({ home, masterKey: parseMasterKey(masterKey) });
  const http = createVaultServer({ vault, host: "127.0.0.1", port: 0 });
  const addr = await http.listen();
  try {
    vault.setSecret("STRIPE_KEY", "sk_live_shim_test_value_1234");
    vault.approveGrant({ secretName: "STRIPE_KEY", agentId: "cursor", toolId: "http_request", scope: "session" });
    const frames = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"cursor","version":"1"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_grants","arguments":{}}}',
    ];
    const { code, stdout, stderr } = await runCli(
      ["mcp", "--remote", `http://127.0.0.1:${addr.port}`],
      { VAULT_HOME: home, VAULT_MASTER_KEY: masterKey },
      `${frames.join("\n")}\n`,
    );
    assert.equal(code, 0, stderr);
    const answers = stdout.trim().split("\n").map((l) => JSON.parse(l) as Rpc);
    assert.equal(answers.length, 2, `initialize and the call answer; the notification is a bare 202:\n${stdout}`);
    assert.equal(answers[0]?.id, 1);
    assert.equal(answers[1]?.id, 2, `the call rode the issued session instead of a 400:\n${stdout}`);
    const text = (answers[1]?.result as { content: { text: string }[] }).content[0]?.text ?? "";
    assert.match(text, /"agent_id": "cursor"/, "the session's agent is the client initialize named");
    assert.ok(!stdout.includes("sk_live_shim_test_value_1234"));
  } finally {
    await http.close();
    vault.close();
    cleanup(home);
  }
});

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
