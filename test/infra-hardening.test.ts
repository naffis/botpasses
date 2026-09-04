/**
 * Regression tests for the infra, boot, CI, logging, and local-server findings (N1 to N12, B6):
 * boot refuses test auth and an unset plane, the approval HMAC is shape-checked and org-bound,
 * two loopback bearers, one request id, trusted-proxy CIDRs, decode and /ready hardening,
 * server timeouts and the SSE cap, the anonymous default resolver, master.key mode, and the
 * workflow secret scoping.
 */
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { hostedDeployPlane } from "../src/brand.ts";
import { main } from "../src/cli.ts";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { testAuthResolver } from "../src/hosted/auth.ts";
import { approvalHmacError, hostedBootError } from "../src/hosted/boot.ts";
import { isHttpError } from "../src/hosted/errors.ts";
import {
  createHostedServer,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SSE_MAX_PER_PRINCIPAL,
  type HostedHttpOpts,
} from "../src/hosted/http.ts";
import { decodePathSegment } from "../src/hosted/http-util.ts";
import {
  CLOUDFLARE_PROXY_CIDRS,
  clientIpFromHeaders,
  ipInCidrs,
  trustedProxyCidrs,
} from "../src/hosted/identity-limiter.ts";
import { mintApprovalToken, verifyApprovalToken } from "../src/hosted/kernel-grant-approval.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { createVaultServer, LOCAL_BODY_CAP, localHostAllowed, loopbackRoleFor } from "../src/server.ts";
import { openHostedSqlite, type SqliteHostedStore } from "../src/store/sqlite-hosted.ts";
import type { VaultStore } from "../src/store/types.ts";
import { loadMasterKey, masterKeyModeError } from "../src/vault.ts";
import { CANARY, captureIo, cleanup, hostedBootEnv, makeVault, tempHome } from "./helpers.ts";

const SITE = join(process.cwd(), "site/dist");

/** The shared env plus a raw KEK, so the control case boots. */
function bootEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return hostedBootEnv({ VAULT_KEK: "aa".repeat(32), ...extra });
}

/* ---- N1, N3: boot invariants ---- */

test("N1: VAULT_AUTH_MODE=test is refused in hosted mode with or without a plane", () => {
  assert.equal(hostedBootError(bootEnv()), undefined, "control: the env boots");
  assert.match(hostedBootError(bootEnv({ VAULT_AUTH_MODE: "test" })) ?? "", /VAULT_AUTH_MODE/);
  const noPlane = bootEnv({ VAULT_AUTH_MODE: "test" });
  delete noPlane.VAULT_DEPLOY_PLANE;
  assert.match(hostedBootError(noPlane) ?? "", /VAULT_AUTH_MODE/, "no plane is not a loophole");
});

test("N3: an unset VAULT_DEPLOY_PLANE is a boot error, never a silent production default", () => {
  const env = bootEnv();
  delete env.VAULT_DEPLOY_PLANE;
  assert.match(hostedBootError(env) ?? "", /VAULT_DEPLOY_PLANE/);
  assert.match(hostedBootError(bootEnv({ VAULT_DEPLOY_PLANE: "prod" })) ?? "", /VAULT_DEPLOY_PLANE/);
  assert.throws(() => hostedDeployPlane({ VAULT_MODE: "hosted" }), /VAULT_DEPLOY_PLANE/);
  assert.equal(hostedDeployPlane({ VAULT_MODE: "hosted", VAULT_DEPLOY_PLANE: "staging" }), "staging");
  assert.equal(hostedDeployPlane({}), "production", "local tooling keeps the old default");
});

/* ---- N4: approval HMAC ---- */

test("N4: VAULT_APPROVAL_HMAC must be 64 hex chars; the kernel refuses a short key; links are org-bound", () => {
  assert.equal(approvalHmacError(undefined), undefined);
  assert.equal(approvalHmacError(""), undefined);
  assert.equal(approvalHmacError("ab".repeat(32)), undefined);
  assert.match(approvalHmacError("not-hex") ?? "", /VAULT_APPROVAL_HMAC/);
  assert.match(approvalHmacError("AB".repeat(32)) ?? "", /VAULT_APPROVAL_HMAC/, "uppercase is not accepted");
  assert.match(hostedBootError(bootEnv({ VAULT_APPROVAL_HMAC: "abc" })) ?? "", /VAULT_APPROVAL_HMAC/);
  assert.equal(hostedBootError(bootEnv({ VAULT_APPROVAL_HMAC: "ab".repeat(32) })), undefined);

  const home = tempHome();
  const store = openHostedSqlite(join(home, "h.sqlite"));
  try {
    assert.throws(
      () => new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), approvalHmac: Buffer.from("short") }),
      /32 bytes/,
    );
  } finally {
    void store.close();
    cleanup(home);
  }

  const hmac = Buffer.from("cc".repeat(32), "hex");
  const token = mintApprovalToken(hmac, "grt_1", Date.now() + 60_000, "org_a");
  assert.equal(verifyApprovalToken(hmac, token, Date.now(), "org_a"), "grt_1");
  assert.throws(
    () => verifyApprovalToken(hmac, token, Date.now(), "org_b"),
    (e: unknown) => isHttpError(e) && e.status === 410,
    "a link minted for one org is invalid in another",
  );
});

/* ---- N2, N9, B6: local loopback server ---- */

test("N2: the operator bearer opens /api only and the model bearer opens POST /mcp only", async () => {
  const { vault, home } = makeVault();
  const http = createVaultServer({ vault, host: "127.0.0.1", port: 0 });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const operator = vault.loopbackToken("operator");
  const model = vault.loopbackToken("model");
  try {
    assert.notEqual(operator, model);
    assert.equal(loopbackRoleFor("GET", "/api/items"), "operator");
    assert.equal(loopbackRoleFor("POST", "/mcp"), "model");
    assert.equal(loopbackRoleFor("GET", "/health"), undefined);

    const apiWithModel = await fetch(`${base}/api/items`, { headers: { authorization: `Bearer ${model}` } });
    assert.equal(apiWithModel.status, 401, "the model bearer cannot read or approve through /api");
    const apiWithOperator = await fetch(`${base}/api/items`, { headers: { authorization: `Bearer ${operator}` } });
    assert.equal(apiWithOperator.status, 200);

    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const mcpWithOperator = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify(rpc),
    });
    assert.equal(mcpWithOperator.status, 401, "the operator bearer is not an MCP credential");
    const mcpWithModel = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${model}`, "content-type": "application/json" },
      body: JSON.stringify(rpc),
    });
    assert.equal(mcpWithModel.status, 200);
  } finally {
    await http.close();
    vault.close();
    cleanup(home);
  }
});

test("B6, N9: loopback Host only, 128 KiB body cap, nonce CSP on the console, errors not echoed", async () => {
  const { vault, home } = makeVault();
  const http = createVaultServer({ vault, host: "127.0.0.1", port: 0 });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const auth = { authorization: `Bearer ${vault.loopbackToken("operator")}`, "content-type": "application/json" };
  try {
    assert.equal(localHostAllowed("127.0.0.1:8788", "127.0.0.1"), true);
    assert.equal(localHostAllowed("localhost", "127.0.0.1"), true);
    assert.equal(localHostAllowed("[::1]:8788", "127.0.0.1"), true);
    assert.equal(localHostAllowed("evil.example:8788", "127.0.0.1"), false);
    assert.equal(localHostAllowed(undefined, "127.0.0.1"), false);
    // fetch() drops a caller-set Host (forbidden header name); node:http sends it as given.
    const rebinding = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: addr.host, port: addr.port, path: "/health", method: "GET", headers: { host: "attacker.example" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(rebinding, 403, "a DNS-rebinding Host is refused before any route");

    const page = await fetch(`${base}/`);
    const csp = page.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, `CSP carries a script nonce: ${csp}`);
    const html = await page.text();
    assert.ok(html.includes(`<script nonce="${nonce}">`), "the inline script carries the CSP nonce");
    assert.ok(html.includes(`<style nonce="${nonce}">`), "the inline style carries the CSP nonce");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");

    const bad = await fetch(`${base}/api/items`, { method: "POST", headers: auth, body: `{"name": ${CANARY}` });
    assert.equal(bad.status, 400);
    const badBody = await bad.text();
    assert.match(badBody, /Invalid JSON/);
    assert.ok(!badBody.includes(CANARY), "the malformed bytes are not echoed");

    const big = await fetch(`${base}/api/items`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "BIG", value: "x".repeat(LOCAL_BODY_CAP + 1024) }),
    });
    assert.equal(big.status, 413);

    const validation = await fetch(`${base}/api/items`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "bad name!", value: "v" }),
    });
    assert.equal(validation.status, 400, "the vault's own validation still reaches the operator");
    assert.match(((await validation.json()) as { error: string }).error, /Secret names/);
  } finally {
    await http.close();
    vault.close();
    cleanup(home);
  }
});

test("N12: vault set --value is gone; the help text does not offer it", async () => {
  const io = captureIo();
  assert.equal(await main(["--help"], io), 0);
  assert.doesNotMatch(io.stdout.join("\n"), /--value/);
  const home = tempHome();
  const prev = { VAULT_HOME: process.env.VAULT_HOME, VAULT_MASTER_KEY: process.env.VAULT_MASTER_KEY };
  process.env.VAULT_HOME = home;
  process.env.VAULT_MASTER_KEY = generateMasterKey();
  try {
    await assert.rejects(main(["set", "STRIPE_KEY", "--value", CANARY], captureIo()), /value/i);
    const piped = captureIo();
    piped.readStdin = async () => `${CANARY}\n`;
    assert.equal(await main(["set", "STRIPE_KEY"], piped), 0);
    assert.ok(!piped.stdout.join("\n").includes(CANARY));
    const prompted = captureIo();
    prompted.promptSecret = async () => CANARY;
    prompted.readStdin = async () => "";
    assert.equal(await main(["set", "PROMPTED"], prompted), 0, "a terminal prompt supplies the value");
  } finally {
    if (prev.VAULT_HOME === undefined) delete process.env.VAULT_HOME;
    else process.env.VAULT_HOME = prev.VAULT_HOME;
    if (prev.VAULT_MASTER_KEY === undefined) delete process.env.VAULT_MASTER_KEY;
    else process.env.VAULT_MASTER_KEY = prev.VAULT_MASTER_KEY;
    cleanup(home);
  }
});

test("N12: a master.key readable by group or others is refused", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits only");
    return;
  }
  assert.equal(masterKeyModeError("/k", 0o100600), undefined);
  assert.match(masterKeyModeError("/k", 0o100644) ?? "", /chmod 600 \/k/);
  assert.match(masterKeyModeError("/k", 0o100660) ?? "", /readable by other users/);
  const home = tempHome();
  const prev = process.env.VAULT_MASTER_KEY;
  delete process.env.VAULT_MASTER_KEY;
  try {
    const keyPath = join(home, "master.key");
    writeFileSync(keyPath, `${generateMasterKey()}\n`, { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    assert.throws(() => loadMasterKey(home), /chmod 600/);
    chmodSync(keyPath, 0o600);
    assert.equal(loadMasterKey(home).source, "file");
  } finally {
    if (prev !== undefined) process.env.VAULT_MASTER_KEY = prev;
    cleanup(home);
  }
});

/* ---- N7: trusted proxy CIDRs ---- */

test("N7: CF-Connecting-IP is read only when the peer Fly saw is inside the trusted proxy ranges", () => {
  const trust = { trustProxyHeaders: true, trustedProxyCidrs: CLOUDFLARE_PROXY_CIDRS };
  // Behind Cloudflare: Fly saw a Cloudflare edge, the visitor is in CF-Connecting-IP.
  assert.equal(
    clientIpFromHeaders({ cfConnectingIp: "198.51.100.7", flyClientIp: "104.16.1.1", remote: "172.19.0.1" }, trust),
    "198.51.100.7",
  );
  assert.equal(
    clientIpFromHeaders({ cfConnectingIp: "2001:db8::9", flyClientIp: "2606:4700:10::1" }, trust),
    "2001:db8::9",
    "IPv6 edge ranges count too",
  );
  // Direct to the Fly edge: a client can set the header, but its own address is not Cloudflare's.
  assert.equal(
    clientIpFromHeaders({ cfConnectingIp: "198.51.100.7", flyClientIp: "203.0.113.9" }, trust),
    "203.0.113.9",
  );
  assert.equal(clientIpFromHeaders({ cfConnectingIp: "not an ip", flyClientIp: "104.16.1.1" }, trust), "104.16.1.1");
  // No trusted proxy (outside Fly, VAULT_TRUST_PROXY unset): every header is the client's, so the
  // socket peer is the address, and CF-Connecting-IP is not believed even from an edge range.
  assert.equal(
    clientIpFromHeaders(
      {
        cfConnectingIp: "198.51.100.7",
        flyClientIp: "104.16.1.1",
        forwarded: "10.0.0.1, 203.0.113.9",
        remote: "203.0.113.9",
      },
      { ...trust, trustProxyHeaders: false },
    ),
    "203.0.113.9",
  );
  // IPv4-mapped IPv6 sockets report the edge as ::ffff:a.b.c.d.
  assert.equal(clientIpFromHeaders({ cfConnectingIp: "198.51.100.7", remote: "::ffff:104.16.1.1" }, trust), "198.51.100.7");
  // An empty list disables the header; a custom list replaces the default.
  assert.equal(
    clientIpFromHeaders({ cfConnectingIp: "198.51.100.7", flyClientIp: "104.16.1.1" }, { ...trust, trustedProxyCidrs: [] }),
    "104.16.1.1",
  );
  assert.deepEqual(trustedProxyCidrs({ VAULT_TRUSTED_PROXY_CIDRS: "" }), []);
  assert.deepEqual(trustedProxyCidrs({ VAULT_TRUSTED_PROXY_CIDRS: " 10.0.0.0/8 ,fd00::/8" }), ["10.0.0.0/8", "fd00::/8"]);
  assert.equal(trustedProxyCidrs({}), CLOUDFLARE_PROXY_CIDRS);
  assert.equal(ipInCidrs("10.1.2.3", ["10.0.0.0/8"]), true);
  assert.equal(ipInCidrs("11.1.2.3", ["10.0.0.0/8"]), false);
  assert.equal(ipInCidrs("10.1.2.3", ["10.0.0.0/8x", "garbage"]), false, "malformed entries never match");
  assert.equal(ipInCidrs("fe80::1%eth0", ["fe80::/10"]), true, "zone ids are stripped");
  assert.equal(ipInCidrs("0.0.0.0", ["0.0.0.0/0"]), true);
});

/* ---- hosted server fixtures ---- */

async function hostedSetup(
  extra: Partial<HostedHttpOpts> & { store?: (s: SqliteHostedStore) => VaultStore } = {},
) {
  const home = tempHome();
  const sqlite = openHostedSqlite(join(home, "h.sqlite"));
  const store = extra.store ? extra.store(sqlite) : sqlite;
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), publicUrl: "http://127.0.0.1:8788", deployPlane: "staging" });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const { client: model } = await kernel.createModelClient({ orgId, name: "cursor", environment: "staging" });
  const serverOpts: Partial<HostedHttpOpts> & { store?: unknown } = { ...extra };
  delete serverOpts.store;
  const http = createHostedServer({ kernel, host: "127.0.0.1", port: 0, ...serverOpts });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const op = { "x-test-channel": "operator", "x-test-user": "user_owner", "x-test-org": orgId };
  const modelH = { "x-test-channel": "model", "x-test-client": model.id };
  const close = async () => {
    await http.close();
    await sqlite.close();
    cleanup(home);
  };
  return { kernel, orgId, http, base, op, modelH, close };
}

function storeOverride(overrides: Record<string, (...a: unknown[]) => unknown>) {
  return (s: SqliteHostedStore): VaultStore =>
    new Proxy(s, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop in overrides) return overrides[prop];
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
}

/* ---- N5: one request id ---- */

test("N5: the inbound x-request-id is the id in the 500 body and header, and the message is redacted", async () => {
  const ctx = await hostedSetup({
    authResolver: testAuthResolver,
    store: storeOverride({
      listItems: async () => {
        throw new Error('duplicate key value violates unique constraint "users_email" Key (email)=(ada@example.com)');
      },
    }),
  });
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    const res = await fetch(`${ctx.base}/api/items?environment=staging`, {
      headers: { ...ctx.op, "x-request-id": "fly-req-w4-0001" },
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { request_id: string };
    assert.equal(body.request_id, "fly-req-w4-0001");
    assert.equal(res.headers.get("x-request-id"), "fly-req-w4-0001");
    const errorLine = lines.find((l) => l.includes('"event":"request_error"')) ?? "";
    assert.match(errorLine, /"request_id":"fly-req-w4-0001"/);
    assert.match(errorLine, /Key \(\[redacted\]\)/, "driver key detail is redacted in the log");
    assert.ok(!errorLine.includes("ada@example.com"));
    const exceptionLine = lines.find((l) => l.includes('"event":"exception"')) ?? "";
    assert.match(exceptionLine, /"request_id":"fly-req-w4-0001"/, "captureException got the same id");
    const requestLine = lines.find((l) => l.includes('"event":"request"')) ?? "";
    assert.match(requestLine, /"request_id":"fly-req-w4-0001"/);
  } finally {
    console.error = original;
    await ctx.close();
  }
});

/* ---- N8: decode and /ready ---- */

test("N8: a malformed percent-escape is a 400 on /collect and a 404 on the site, never a 500", async () => {
  assert.equal(decodePathSegment("a%20b"), "a b");
  assert.throws(() => decodePathSegment("%E0%A4%A"), (e: unknown) => isHttpError(e) && e.status === 400);
  const ctx = await hostedSetup({ authResolver: testAuthResolver, siteRoot: SITE });
  try {
    const collect = await fetch(`${ctx.base}/collect/%E0%A4%A`);
    assert.equal(collect.status, 400);
    const site = await fetch(`${ctx.base}/docs/%E0%A4%A`);
    assert.equal(site.status, 404);
    const asset = await fetch(`${ctx.base}/_astro/%zz.css`);
    assert.equal(asset.status, 404);
  } finally {
    await ctx.close();
  }
});

test("N8: /ready answers from a cached ping for 5 s and shares one ping across concurrent probes", async () => {
  let pings = 0;
  const ctx = await hostedSetup({
    store: storeOverride({
      ping: async () => {
        pings += 1;
      },
    }),
  });
  try {
    const first = await Promise.all([fetch(`${ctx.base}/ready`), fetch(`${ctx.base}/ready`), fetch(`${ctx.base}/ready`)]);
    assert.deepEqual(first.map((r) => r.status), [200, 200, 200]);
    const again = await fetch(`${ctx.base}/ready`);
    assert.equal(again.status, 200);
    assert.equal(pings, 1, "four probes inside the window cost one database round trip");
  } finally {
    await ctx.close();
  }
});

/* ---- N9: timeouts and the SSE cap ---- */

test("N9: server timeouts are set and one principal holds at most four SSE streams", async () => {
  const ctx = await hostedSetup({ authResolver: testAuthResolver });
  const controllers: AbortController[] = [];
  try {
    assert.equal(HEADERS_TIMEOUT_MS, 15_000);
    assert.equal(REQUEST_TIMEOUT_MS, 30_000);
    assert.equal(KEEP_ALIVE_TIMEOUT_MS, 65_000);
    assert.equal(ctx.http.server.headersTimeout, HEADERS_TIMEOUT_MS);
    assert.equal(ctx.http.server.requestTimeout, REQUEST_TIMEOUT_MS);
    assert.equal(ctx.http.server.keepAliveTimeout, KEEP_ALIVE_TIMEOUT_MS);
    assert.equal(SSE_MAX_PER_PRINCIPAL, 4);

    for (let i = 0; i < SSE_MAX_PER_PRINCIPAL; i += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      const res = await fetch(`${ctx.base}/mcp`, { headers: ctx.modelH, signal: controller.signal });
      assert.equal(res.status, 200, `stream ${i + 1} opens`);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    }
    const fifth = await fetch(`${ctx.base}/mcp`, { headers: ctx.modelH });
    assert.equal(fifth.status, 429);
    assert.equal(((await fifth.json()) as { max_streams: number }).max_streams, SSE_MAX_PER_PRINCIPAL);

    // The operator is a different bucket.
    const opController = new AbortController();
    controllers.push(opController);
    const opStream = await fetch(`${ctx.base}/mcp`, { headers: ctx.op, signal: opController.signal });
    assert.equal(opStream.status, 200);

    // Closing one stream frees its slot.
    controllers[0]?.abort();
    let reopened = 0;
    for (let attempt = 0; attempt < 50 && reopened !== 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const controller = new AbortController();
      const res = await fetch(`${ctx.base}/mcp`, { headers: ctx.modelH, signal: controller.signal });
      reopened = res.status;
      if (res.status === 200) controllers.push(controller);
    }
    assert.equal(reopened, 200, "a closed stream's slot is reusable");
  } finally {
    for (const c of controllers) c.abort();
    await ctx.close();
  }
});

/* ---- N11: default resolver ---- */

test("N11: createHostedServer without an authResolver authenticates nobody, test headers included", async () => {
  const ctx = await hostedSetup();
  try {
    const res = await fetch(`${ctx.base}/api/items?environment=staging`, { headers: ctx.op });
    assert.equal(res.status, 401, "x-test-* headers are not a principal unless testAuthResolver is passed");
    const stream = await fetch(`${ctx.base}/mcp`, { headers: ctx.modelH });
    assert.equal(stream.status, 401);
  } finally {
    await ctx.close();
  }
});

/* ---- N6, N10: workflows ---- */

test("N6, N10: deploy and backup secrets are environment-scoped, flyctl names its app, prod checks the staging run", () => {
  const staging = readFileSync(join(process.cwd(), ".github/workflows/deploy-staging.yml"), "utf8");
  const prod = readFileSync(join(process.cwd(), ".github/workflows/deploy-prod.yml"), "utf8");
  const backup = readFileSync(join(process.cwd(), ".github/workflows/backup-prod.yml"), "utf8");
  assert.match(staging, /environment: staging/);
  assert.match(staging, /flyctl deploy [^\n]*-a botpasses-staging/);
  assert.match(prod, /environment: production/);
  assert.match(prod, /flyctl deploy [^\n]*-a botpasses-prod/);
  assert.match(prod, /actions: read/);
  assert.match(prod, /deploy-staging\.yml\/runs\?head_sha=/, "the staging deploy run for the SHA is checked");
  assert.match(prod, /conclusion == "success"/);
  // Every job that reads a deploy or backup secret must declare the environment that holds it.
  const jobsOf = (yaml: string): string[] => {
    const section = yaml.slice(yaml.indexOf("\njobs:\n") + "\njobs:\n".length);
    return section.split(/\n(?=[ ]{2}[a-z-]+:\n)/).map((j) => j.trim()).filter(Boolean);
  };
  const backupJobs = jobsOf(backup);
  assert.equal(backupJobs.length, 2, "dump and backup-verify");
  for (const job of backupJobs) assert.match(job, /environment: backup/);
  const secretRef = /secrets\.(FLY_API_TOKEN|BACKUP_KEY|DATABASE_URL_DIRECT|R2_\w+)/;
  for (const [name, yaml] of [["staging", staging], ["prod", prod], ["backup", backup]] as const) {
    const jobs = jobsOf(yaml);
    assert.ok(jobs.some((j) => secretRef.test(j)), `${name}: at least one job uses a scoped secret`);
    for (const job of jobs) {
      if (secretRef.test(job)) assert.match(job, /\n\s+environment: (staging|production|backup)\n/, `${name}: ${job.slice(0, 40)}`);
    }
  }
});
