import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { stdin as input } from "node:process";
import {
  DEFAULT_HOME_DIRNAME,
  PRODUCT_NAME,
  publicOriginError,
  resolvePublicOrigin,
  STAGING_ORIGIN,
} from "./brand.ts";
import { generateMasterKey, parseMasterKey } from "./crypto.ts";
import { maskLast4 } from "./ids.ts";
import { runMcpStdio } from "./mcp-stdio.ts";
import { createVaultServer } from "./server.ts";
import { defaultHome, initVaultHome, loadMasterKey, Vault } from "./vault.ts";
import type { GrantScope } from "./types.ts";

// Hosted dependencies (pg, the AWS KMS SDK, oidc-provider) load only for the commands that
// need them, so `vault set` and `vault list` stay a sqlite-only startup.
function loadHostedMain(): Promise<typeof import("./hosted/main.ts")> {
  return import("./hosted/main.ts");
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
};

const defaultIo: Io = {
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
  readStdin: readStdin,
};

const USAGE = `${PRODUCT_NAME}: named credentials for agents and tools, never for the model.

Usage:
  vault init
  vault set NAME [--value VALUE] [--host api.example.com]... [--inject bearer|basic|header:Name]
    --host allowlists the API hosts http_request may send this credential to (repeatable)
  vault list
  vault grant --secret NAME --agent AGENT --tool TOOL [--once|--session] [--ttl 8h]
  vault grant --id GRANT_ID --agent AGENT --tool TOOL
    MCP http_request grants use --tool http_request; the agent is the MCP client's name
  vault revoke --id GRANT_ID
  vault revoke --secret NAME --agent AGENT --tool TOOL
  vault audit
  vault run --with NAME [--with NAME] --agent AGENT --tool TOOL -- COMMAND
  vault serve [--host 127.0.0.1] [--port 8788]
    prints a loopback bearer (HMAC of the master key); send it as Authorization on /api and POST /mcp
  vault login
  vault mcp [--user-jwt JWT]
    stdio MCP with list_items, find_items, request_grant, list_grants, http_request (same as hosted)
  vault kek-wrap
  vault kek-rotate

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
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      value: { type: "string" },
      host: { type: "string", multiple: true },
      inject: { type: "string" },
    },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (!name) {
    io.error("Usage: vault set NAME [--value VALUE] [--host api.example.com]... [--inject bearer|basic|header:Name]");
    io.error("Prefer piping the value on stdin so it is not visible in `ps`.");
    return 1;
  }
  let value = values.value;
  if (value === undefined) {
    const piped = await io.readStdin();
    value = piped.replace(/\r?\n$/, "");
  }
  if (!value) {
    io.error("No value. Pipe the secret on stdin or pass --value (argv is visible in process lists).");
    return 1;
  }
  const vault = open();
  try {
    const meta = vault.setSecret(name, value, { allowedHosts: values.host, inject: values.inject });
    const hosts = meta.allowedHosts.length ? ` hosts=${meta.allowedHosts.join(",")}` : "";
    io.log(`Stored ${meta.name} ${maskLast4(meta.last4)}${hosts} inject=${meta.inject} (value not shown)`);
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
    io.error("Usage: vault grant --secret NAME --agent AGENT --tool TOOL [--once|--session]");
    return 1;
  }
  const scope: GrantScope = values.session ? "session" : "once";
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
    const { startHosted } = await loadHostedMain();
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
  const vault = open();
  const port = Number(values.port);
  const http = createVaultServer({ vault, host: values.host, port });
  const addr = await http.listen();
  io.error(`${PRODUCT_NAME} listening on http://${addr.host}:${addr.port}`);
  io.error(`Loopback token: ${vault.loopbackToken()}`);
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

async function cmdMcp(argv: string[], io: Io): Promise<number> {
  const jwtIdx = argv.indexOf("--user-jwt");
  const wantsJwt = jwtIdx >= 0 || Boolean(process.env.VAULT_USER_JWT);
  if (wantsJwt) {
    const next = jwtIdx >= 0 ? argv[jwtIdx + 1] : undefined;
    const token =
      next && !next.startsWith("-") ? next : process.env.VAULT_USER_JWT;
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
  const plane = process.env.VAULT_DEPLOY_PLANE;
  const app = process.env.FLY_APP_NAME?.trim() ?? "";
  if (!keyId || (plane !== "staging" && plane !== "production") || !app) {
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
  const newHex = generateMasterKey();
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
    const plane = process.env.VAULT_DEPLOY_PLANE;
    const app = process.env.FLY_APP_NAME?.trim() ?? "";
    if (keyId && (plane === "staging" || plane === "production") && app) {
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

function splitRun(argv: string[]): { vaultArgs: string[]; childArgs: string[] } {
  const idx = argv.indexOf("--");
  if (idx === -1) return { vaultArgs: argv, childArgs: [] };
  return { vaultArgs: argv.slice(0, idx), childArgs: argv.slice(idx + 1) };
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
