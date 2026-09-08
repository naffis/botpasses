import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { stdin as input } from "node:process";
import {
  DEFAULT_HOME_DIRNAME,
  deployPlaneRaw,
  PRODUCT_NAME,
  publicOriginError,
  resolvePublicOrigin,
  STAGING_ORIGIN,
} from "./brand.ts";
import { generateMasterKey, parseMasterKey } from "./crypto.ts";
import { maskLast4 } from "./ids.ts";
import { runMcpStdio } from "./mcp-stdio.ts";
import { createVaultServer } from "./server.ts";
import { defaultHome, initVaultHome, loadMasterKey, loopbackBearer, Vault } from "./vault.ts";
import type { LocalGrantScope } from "./types.ts";

// Hosted dependencies (pg, the AWS KMS SDK, oidc-provider) load only for the commands that
// need them, so `vault set` and `vault list` stay a sqlite-only startup.
function loadHostedMain(): Promise<typeof import("./hosted/main.ts")> {
  return import("./hosted/main.ts");
}
function loadHostedBoot(): Promise<typeof import("./hosted/boot.ts")> {
  return import("./hosted/boot.ts");
}
function loadHostedKernel(): Promise<typeof import("./hosted/kernel.ts")> {
  return import("./hosted/kernel.ts");
}
function loadKms(): Promise<typeof import("./hosted/kms.ts")> {
  return import("./hosted/kms.ts");
}
function loadPostgresStore(): Promise<typeof import("./store/postgres.ts")> {
  return import("./store/postgres.ts");
}
function loadRemoteMcp(): Promise<typeof import("./hosted/mcp-stdio-remote.ts")> {
  return import("./hosted/mcp-stdio-remote.ts");
}

export type Io = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  readStdin: () => Promise<string>;
  /** Reads one line from an interactive terminal without echo. Absent when stdin is not a TTY. */
  promptSecret?: (label: string) => Promise<string>;
};

const defaultIo: Io = {
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
  readStdin: readStdin,
  promptSecret: input.isTTY ? promptSecret : undefined,
};

const USAGE = `${PRODUCT_NAME}: named credentials for agents and tools, never for the model.

Usage:
  vault init
  vault set NAME [--host api.example.com]... [--inject bearer|basic|header:Name|...] [--username USER]
    reads the value from stdin (pipe it) or prompts without echo on a terminal; never from argv
    --host allowlists the API hosts http_request may send this credential to (repeatable)
    --inject takes the hosted vocabulary: bearer, basic, client_credentials, refresh, sigv4,
      header:Name, query:param, cookie:name, hmac:stripe_sig|slack_sig|github_sig
    --username is the HTTP Basic user, OAuth client id, or AWS access key id (--username "" clears it)
  vault list
  vault grant --secret NAME --agent AGENT --tool TOOL [--once|--session [--ttl 8h]]
  vault grant --id GRANT_ID --agent AGENT --tool TOOL
    MCP http_request grants use --tool http_request; the agent is the MCP client's name
    --once (default) is spent by the first use; --ttl applies to --session only (default 8h)
  vault revoke --id GRANT_ID
  vault revoke --secret NAME --agent AGENT --tool TOOL
  vault audit
  vault run --with NAME [--with NAME] --agent AGENT --tool TOOL -- COMMAND
  vault serve [--host 127.0.0.1] [--port 8788]
    prints two loopback bearers (HMACs of the master key): the operator bearer is the
    Authorization for /api and the console; the model bearer is the Authorization for POST /mcp
  vault login
  vault mcp [--remote [http://127.0.0.1:8788]] [--user-jwt [JWT]]
    stdio MCP with list_items, find_items, request_grant, list_grants, setup, http_request (same as hosted)
    --remote forwards stdio to a running vault serve with the model bearer
    --user-jwt proxies the hosted server; the token is the flag's value or VAULT_USER_JWT
  vault kek-wrap
  vault kek-rotate
  vault <command> --help

Env:
  VAULT_MASTER_KEY   32-byte key as 64 hex chars (preferred) or base64
  VAULT_HOME         data dir (default ~/${DEFAULT_HOME_DIRNAME})
  VAULT_ACTOR        audit actor (default $USER)
  VAULT_PUBLIC_URL   hosted origin for vault mcp --user-jwt
  VAULT_USER_JWT     operator or MCP access token from this origin
`;

export async function main(argv = process.argv.slice(2), io: Io = defaultIo): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    io.log(USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  const [command = "", ...rest] = argv;
  // Per-command help is answered before any option parsing, so `vault grant --help` prints usage
  // instead of "Unknown option" and `vault mcp --help` does not start serving.
  if (wantsHelp(rest)) {
    io.log(USAGE);
    return 0;
  }
  switch (command) {
    case "init":
      return cmdInit(io);
    case "set":
      return cmdSet(rest, io);
    case "list":
      return cmdList(io);
    case "grant":
      return cmdGrant(rest, io);
    case "revoke":
      return cmdRevoke(rest, io);
    case "audit":
      return cmdAudit(io);
    case "run":
      return cmdRun(rest, io);
    case "serve":
      return cmdServe(rest, io);
    case "login":
      return cmdLogin(io);
    case "mcp":
      return cmdMcp(rest, io);
    case "kek-wrap":
      return cmdKekWrap(io);
    case "kek-rotate":
      return cmdKekRotate(io);
    default:
      io.error(`Unknown command: ${command}`);
      io.error(USAGE);
      return 1;
  }
}

function cmdInit(io: Io): number {
  const home = defaultHome();
  const result = initVaultHome(home);
  io.log(`Vault initialized at ${result.home}`);
  io.log(`Key source: ${result.keySource}`);
  io.log(`Key fingerprint: ${result.fingerprint}`);
  if (result.generatedKey) {
    io.log("");
    io.log("A master.key file was written with mode 0600.");
    io.log("Preferred: keep the key in the environment instead of the file:");
    io.log(`  export VAULT_MASTER_KEY=${result.generatedKey}`);
    io.log("Do not commit this key. The vault process needs it to decrypt envelopes.");
  } else if (result.keySource === "env") {
    io.log("Using VAULT_MASTER_KEY from the environment.");
  }
  io.log("");
  io.log("Next: vault set NAME --host api.example.com   then  vault grant --secret NAME --agent AGENT --tool http_request");
  return 0;
}

async function cmdSet(argv: string[], io: Io): Promise<number> {
  // No `--value`: argv is visible to every process on the machine (`ps`, shell history).
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      host: { type: "string", multiple: true },
      inject: { type: "string" },
      username: { type: "string" },
    },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (!name) {
    io.error("Usage: vault set NAME [--host api.example.com]... [--inject bearer|basic|header:Name|...] [--username USER]");
    io.error("Pipe the value on stdin, or run on a terminal to be prompted without echo.");
    return 1;
  }
  const raw = io.promptSecret ? await io.promptSecret(`Value for ${name} (not echoed): `) : await io.readStdin();
  const value = raw.replace(/\r?\n$/, "");
  if (!value) {
    io.error("No value. Pipe the secret on stdin (printf '%s' VALUE | vault set NAME) or type it at the prompt.");
    return 1;
  }
  const vault = open();
  try {
    const meta = vault.setSecret(name, value, { allowedHosts: values.host, inject: values.inject, username: values.username });
    const hosts = meta.allowedHosts.length ? ` hosts=${meta.allowedHosts.join(",")}` : "";
    const user = meta.username ? ` username=${meta.username}` : "";
    io.log(`Stored ${meta.name} ${maskLast4(meta.last4)}${hosts} inject=${meta.inject}${user} (value not shown)`);
    return 0;
  } finally {
    vault.close();
  }
}

function cmdList(io: Io): number {
  const vault = open();
  try {
    const items = vault.listItems();
    if (items.length === 0) {
      io.log("No credentials.");
      return 0;
    }
    for (const s of items) {
      const hosts = s.allowedHosts.length ? s.allowedHosts.join(",") : "-";
      io.log(`${s.name}\t${maskLast4(s.last4)}\t${hosts}\t${s.inject}\tupdated ${s.updatedAt}`);
    }
    return 0;
  } finally {
    vault.close();
  }
}

function cmdGrant(argv: string[], io: Io): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      secret: { type: "string" },
      agent: { type: "string" },
      tool: { type: "string" },
      id: { type: "string" },
      once: { type: "boolean", default: false },
      session: { type: "boolean", default: false },
      ttl: { type: "string" },
    },
    allowPositionals: false,
  });
  if (!values.agent || !values.tool) {
    io.error("Usage: vault grant --secret NAME --agent AGENT --tool TOOL [--once|--session] [--ttl 8h]");
    return 1;
  }
  if (values.once && values.session) {
    io.error("Pass --once or --session, not both.");
    return 1;
  }
  if (values.ttl !== undefined && !values.session) {
    io.error("--ttl applies to --session grants only; a --once grant is spent by its first use and has no expiry.");
    return 1;
  }
  const scope: LocalGrantScope = values.session ? "session" : "once";
  const vault = open();
  try {
    const grant = vault.approveGrant({
      grantId: values.id,
      secretName: values.secret,
      agentId: values.agent,
      toolId: values.tool,
      scope,
      ttl: values.ttl,
    });
    io.log(
      `Granted ${grant.secretName} → tool ${grant.toolId} (agent ${grant.agentId}) scope=${grant.scope} id=${grant.id}`,
    );
    return 0;
  } finally {
    vault.close();
  }
}

function cmdRevoke(argv: string[], io: Io): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      secret: { type: "string" },
      agent: { type: "string" },
      tool: { type: "string" },
      id: { type: "string" },
    },
    allowPositionals: false,
  });
  const vault = open();
  try {
    const grants = vault.revokeGrant({
      grantId: values.id,
      secretName: values.secret,
      agentId: values.agent,
      toolId: values.tool,
    });
    if (grants.length === 0) {
      io.log("Nothing to revoke.");
      return 0;
    }
    for (const g of grants) {
      io.log(`Revoked ${g.id} ${g.secretName} → ${g.toolId} (${g.agentId})`);
    }
    return 0;
  } finally {
    vault.close();
  }
}

function cmdAudit(io: Io): number {
  const vault = open();
  try {
    const rows = vault.listAudit();
    if (rows.length === 0) {
      io.log("No audit events.");
      return 0;
    }
    for (const row of rows) {
      io.log(
        [
          row.createdAt,
          row.action,
          `actor=${row.actor}`,
          row.secretName ? `secret=${row.secretName}` : "",
          row.agentId ? `agent=${row.agentId}` : "",
          row.toolId ? `tool=${row.toolId}` : "",
        ]
          .filter(Boolean)
          .join("  "),
      );
    }
    return 0;
  } finally {
    vault.close();
  }
}

async function cmdRun(argv: string[], io: Io): Promise<number> {
  const { vaultArgs, childArgs } = splitRun(argv);
  const { values } = parseArgs({
    args: vaultArgs,
    options: {
      with: { type: "string", multiple: true },
      agent: { type: "string" },
      tool: { type: "string" },
    },
    allowPositionals: false,
  });
  const names = values.with ?? [];
  if (names.length === 0 || !values.agent || !values.tool || childArgs.length === 0) {
    io.error("Usage: vault run --with NAME --agent AGENT --tool TOOL -- COMMAND");
    return 1;
  }
  const vault = open();
  try {
    io.error(
      `[vault] injecting ${names.length} granted secret(s) into child env (values not printed)`,
    );
    const result = await vault.runWithSecrets({
      bindings: names.map((secretName) => ({ secretName })),
      agentId: values.agent,
      toolId: values.tool,
      command: childArgs,
      inheritStdio: true,
    });
    return result.code ?? 1;
  } finally {
    vault.close();
  }
}

async function cmdServe(argv: string[], io: Io): Promise<number> {
  if (process.env.VAULT_MODE === "hosted") {
    // Same last-resort guards as `npm run hosted`: an unknown broken invariant exits 1 so Fly
    // restarts the Machine instead of a half-alive process serving requests.
    const [{ startHosted }, { installProcessGuards }] = await Promise.all([loadHostedMain(), loadHostedBoot()]);
    installProcessGuards();
    await startHosted();
    return 0;
  }
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8788" },
    },
    allowPositionals: false,
  });
  const port = parsePort(values.port);
  if (port === undefined) {
    io.error(`--port must be a whole number from 1 to 65535 (got "${values.port}").`);
    return 1;
  }
  const vault = open();
  const http = createVaultServer({ vault, host: values.host, port });
  const addr = await http.listen();
  io.error(`${PRODUCT_NAME} listening on http://${addr.host}:${addr.port}`);
  io.error(`Operator bearer (console and /api): ${vault.loopbackToken("operator")}`);
  io.error(`Model bearer (POST /mcp, vault mcp --remote): ${vault.loopbackToken("model")}`);
  io.error("Operator console shows names + last-4 only. MCP is POST /mcp. Bind is loopback by default.");
  await new Promise<void>((resolve) => {
    const stop = () => {
      void http.close().then(() => {
        vault.close();
        resolve();
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

function cmdLogin(io: Io): number {
  const raw = process.env.VAULT_PUBLIC_URL;
  if (raw) {
    const err = publicOriginError(raw, { allowLoopback: true });
    if (err) {
      io.error(err);
      return 1;
    }
  }
  const url = raw ? resolvePublicOrigin(raw) : STAGING_ORIGIN;
  io.log(`Sign in at ${url}/sign-in then open ${url}/console.`);
  io.log(`Device login: ${url}/device`);
  io.log("Connect MCP to this origin. Clients discover the authorization server here.");
  io.log("     export VAULT_PUBLIC_URL=" + url);
  io.log("     vault mcp --user-jwt");
  return 0;
}

const MCP_USAGE = "Usage: vault mcp [--remote [http://127.0.0.1:8788]] [--user-jwt [JWT]]";

/**
 * `--remote` and `--user-jwt` both take an optional value, which parseArgs has no notion of:
 * a bare `--user-jwt` becomes `--user-jwt=` (the token then comes from VAULT_USER_JWT) and
 * `--remote=URL` becomes `--remote URL` so the URL is read as a positional.
 */
export function normalizeMcpArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--user-jwt") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        out.push("--user-jwt=");
        continue;
      }
    }
    if (arg.startsWith("--remote=")) {
      out.push("--remote", arg.slice("--remote=".length));
      continue;
    }
    out.push(arg);
  }
  return out;
}

async function cmdMcp(argv: string[], io: Io): Promise<number> {
  let values: { remote: boolean; "user-jwt"?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: normalizeMcpArgs(argv),
      options: {
        remote: { type: "boolean", default: false },
        "user-jwt": { type: "string" },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    io.error(MCP_USAGE);
    return 1;
  }
  const jwtOption = values["user-jwt"];
  if (values.remote && jwtOption !== undefined) {
    io.error("Pass --remote or --user-jwt, not both.");
    return 1;
  }
  if (!values.remote && positionals.length > 0) {
    io.error(`Unexpected argument: ${positionals[0]}`);
    io.error(MCP_USAGE);
    return 1;
  }
  if (values.remote) {
    // Forward stdio to a running `vault serve` on loopback with the model bearer. The bearer is
    // derived from the master key here, so nothing is pasted into an MCP client's config.
    const rawUrl = positionals[0] ?? "http://127.0.0.1:8788";
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      io.error("vault mcp --remote takes a loopback URL such as http://127.0.0.1:8788.");
      return 1;
    }
    if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
      io.error("vault mcp --remote only forwards to a loopback vault serve (http://127.0.0.1:PORT).");
      return 1;
    }
    const { key } = loadMasterKey(defaultHome());
    const { runRemoteMcpStdio } = await loadRemoteMcp();
    await runRemoteMcpStdio({ publicUrl: target.origin, userJwt: loopbackBearer(key, "model") });
    return 0;
  }
  // The option's presence (in either `--user-jwt TOKEN` or `--user-jwt=TOKEN` form) means hosted
  // mode; it must never fall through to serving the local vault because the token was not seen.
  const wantsJwt = jwtOption !== undefined || Boolean(process.env.VAULT_USER_JWT);
  if (wantsJwt) {
    const token = jwtOption || process.env.VAULT_USER_JWT;
    const rawUrl = process.env.VAULT_PUBLIC_URL;
    if (!rawUrl) {
      io.error("VAULT_PUBLIC_URL is required for hosted stdio MCP.");
      return 1;
    }
    const originErr = publicOriginError(rawUrl, { allowLoopback: true });
    if (originErr) {
      io.error(originErr);
      return 1;
    }
    const publicUrl = resolvePublicOrigin(rawUrl);
    if (!token) {
      io.error("Pass --user-jwt <token> or set VAULT_USER_JWT. Run `vault login`.");
      return 1;
    }
    const { runRemoteMcpStdio } = await loadRemoteMcp();
    await runRemoteMcpStdio({ publicUrl, userJwt: token });
    return 0;
  }
  const vault = open();
  try {
    await runMcpStdio(vault);
    return 0;
  } finally {
    vault.close();
  }
}

function refuseMachineKekCli(io: Io): boolean {
  if (process.env.VAULT_MODE === "hosted" && process.env.FLY_ALLOC_ID) {
    io.error("vault kek-wrap / kek-rotate run on an operator laptop, not on the Fly Machine.");
    return true;
  }
  return false;
}

async function cmdKekWrap(io: Io): Promise<number> {
  if (refuseMachineKekCli(io)) return 1;
  const keyId = process.env.VAULT_KMS_KEY_ID?.trim() ?? "";
  const plane = deployPlaneRaw(process.env);
  const app = process.env.FLY_APP_NAME?.trim() ?? "";
  if (!keyId || !plane || !app) {
    io.error(
      "vault kek-wrap requires VAULT_KMS_KEY_ID, VAULT_DEPLOY_PLANE=staging|production, FLY_APP_NAME, and laptop AWS credentials (SSO or console Encrypt). Fly OIDC is Machine-only.",
    );
    return 1;
  }
  const raw = (await io.readStdin()).trim();
  if (!raw) {
    io.error("Pass the raw 32-byte KEK on stdin (64 hex chars).");
    return 1;
  }
  const key = parseMasterKey(raw);
  try {
    const { awsKmsEncrypt, kekEncryptionContext } = await loadKms();
    const cipher = await awsKmsEncrypt(keyId)(key, kekEncryptionContext({ plane, app }));
    io.log(cipher.toString("base64"));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.error(`KMS Encrypt failed. Use AWS SSO or the console Encrypt API. ${message}`);
    return 1;
  }
}

async function cmdKekRotate(io: Io): Promise<number> {
  if (refuseMachineKekCli(io)) return 1;
  const db = process.env.DATABASE_URL?.trim() ?? "";
  const oldRaw = process.env.VAULT_KEK?.trim() ?? "";
  if (!db || !oldRaw) {
    io.error("vault kek-rotate requires DATABASE_URL and VAULT_KEK (the current raw platform KEK).");
    return 1;
  }
  const oldKek = parseMasterKey(oldRaw);
  // VAULT_KEK_NEW: the KEK the running process already has as current (docs/ops/kek-rotation.md);
  // without it a fresh key is generated, which is only right before that deploy.
  const newHex = process.env.VAULT_KEK_NEW?.trim() || generateMasterKey();
  const newKek = parseMasterKey(newHex);
  const [{ PostgresStore }, { HostedKernel }, { awsKmsEncrypt, kekEncryptionContext }] = await Promise.all([
    loadPostgresStore(),
    loadHostedKernel(),
    loadKms(),
  ]);
  const store = await PostgresStore.open(db, { plane: "kek-rotate" });
  try {
    const kernel = new HostedKernel({ store, kek: oldKek });
    const result = await kernel.rotateKek(oldKek, newKek);
    io.error(`rewrapped=${result.rewrapped} skipped=${result.skipped} identity=${JSON.stringify(result.identity)}`);
    const keyId = process.env.VAULT_KMS_KEY_ID?.trim() ?? "";
    const plane = deployPlaneRaw(process.env);
    const app = process.env.FLY_APP_NAME?.trim() ?? "";
    if (keyId && plane && app) {
      const cipher = await awsKmsEncrypt(keyId)(newKek, kekEncryptionContext({ plane, app }));
      io.log(cipher.toString("base64"));
    } else {
      io.log(newHex);
      io.error("Set VAULT_KMS_KEY_ID, VAULT_DEPLOY_PLANE, and FLY_APP_NAME to print a KMS-wrapped blob instead of raw hex.");
    }
    return 0;
  } finally {
    await store.close();
  }
}

function open(): Vault {
  const home = defaultHome();
  const { key } = loadMasterKey(home);
  return new Vault({ home, masterKey: key });
}

/** `-h` or `--help` anywhere before `--`; a child command after `--` keeps its own flags. */
function wantsHelp(args: string[]): boolean {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).some((a) => a === "-h" || a === "--help");
}

/** A TCP port from argv, or undefined for anything that is not a whole number in range. */
export function parsePort(raw: string): number | undefined {
  if (!/^\d{1,5}$/.test(raw.trim())) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function splitRun(argv: string[]): { vaultArgs: string[]; childArgs: string[] } {
  const idx = argv.indexOf("--");
  if (idx === -1) return { vaultArgs: argv, childArgs: [] };
  return { vaultArgs: argv.slice(0, idx), childArgs: argv.slice(idx + 1) };
}

/** One line from the terminal with echo off. Ctrl-C aborts with exit 130 like any prompt. */
function promptSecret(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(label);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let buf = "";
    const finish = (err?: Error) => {
      input.setRawMode(wasRaw);
      input.pause();
      input.off("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          finish(new Error("Aborted"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    input.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  if (input.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      process.exit(1);
    },
  );
}
