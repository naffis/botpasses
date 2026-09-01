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
import { maskLast4 } from "./ids.ts";
import { runMcpStdio } from "./mcp-stdio.ts";
import { createVaultServer } from "./server.ts";
import { defaultHome, initVaultHome, loadMasterKey, Vault } from "./vault.ts";
import type { GrantScope } from "./types.ts";
import { startHosted } from "./hosted/main.ts";
import { runRemoteMcpStdio } from "./hosted/mcp-stdio-remote.ts";

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

const USAGE = `${PRODUCT_NAME} — named secrets for agents and tools, never for the model.

Usage:
  vault init
  vault set NAME [--value VALUE]
  vault list
  vault grant --secret NAME --agent AGENT --tool TOOL [--once|--session] [--ttl 8h]
  vault grant --id GRANT_ID --agent AGENT --tool TOOL
  vault revoke --id GRANT_ID
  vault revoke --secret NAME --agent AGENT --tool TOOL
  vault audit
  vault run --with NAME [--with NAME] --agent AGENT --tool TOOL -- COMMAND
  vault serve [--host 127.0.0.1] [--port 8788]
  vault login
  vault mcp [--user-jwt JWT]

Env:
  VAULT_MASTER_KEY   32-byte key as 64 hex chars (preferred) or base64
  VAULT_HOME         data dir (default ~/${DEFAULT_HOME_DIRNAME})
  VAULT_ACTOR        audit actor (default $USER)
  VAULT_PUBLIC_URL   hosted origin for vault mcp --user-jwt
  VAULT_USER_JWT     Clerk session JWT (never the Clerk secret)
`;

export async function main(argv = process.argv.slice(2), io: Io = defaultIo): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    io.log(USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  const [command, ...rest] = argv;
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
  io.log("Next: vault set NAME   then  vault grant --secret NAME --agent AGENT --tool TOOL");
  return 0;
}

async function cmdSet(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { value: { type: "string" } },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (!name) {
    io.error("Usage: vault set NAME [--value VALUE]");
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
    const meta = vault.setSecret(name, value);
    io.log(`Stored ${meta.name} ${maskLast4(meta.last4)} (value not shown)`);
    return 0;
  } finally {
    vault.close();
  }
}

function cmdList(io: Io): number {
  const vault = open();
  try {
    const secrets = vault.listSecrets();
    if (secrets.length === 0) {
      io.log("No secrets.");
      return 0;
    }
    for (const s of secrets) {
      io.log(`${s.name}\t${maskLast4(s.last4)}\tupdated ${s.updatedAt}`);
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
  io.log("Hosted MCP stdio uses your Clerk session JWT, never CLERK_SECRET_KEY.");
  io.log(`1. Sign in at ${url} (Clerk Organizations must be enabled).`);
  io.log("2. Copy the session JWT from the Clerk dashboard session or browser cookie.");
  io.log("3. Export it and start stdio MCP:");
  io.log("     export VAULT_PUBLIC_URL=" + url);
  io.log("     export VAULT_USER_JWT=eyJ...");
  io.log("     vault mcp --user-jwt");
  io.log("Do not put the Clerk secret in mcp.json.");
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
