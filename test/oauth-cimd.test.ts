import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { test } from "node:test";
import { createPinnedFetch } from "../src/hosted/cimd-fetch.ts";
import { HttpError } from "../src/hosted/errors.ts";
import { AUDIENCE, pkce, startOauthServer } from "./oauth-helpers.ts";

const PUBLIC_IP = "93.184.216.34";

async function fixture(): Promise<{ port: number; hits: Map<string, number>; close(): Promise<void> }> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/doc.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=120" });
      res.end(JSON.stringify({ client_id: "https://cimd.example/doc.json", host: req.headers.host }));
      return;
    }
    if (path === "/redirect") {
      res.writeHead(302, { location: "/target" });
      res.end();
      return;
    }
    if (path === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(1024 * 1024 + 1024, 0x61));
      return;
    }
    if (path === "/slow") return;
    if (path === "/empty") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return {
    port: addr.port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("pinned fetch connects to the resolved IP with SNI and Host for the real name, never follows redirects", async () => {
  const fx = await fixture();
  const seen: RequestOptions[] = [];
  const pinned = createPinnedFetch({
    resolve: async () => [PUBLIC_IP],
    request: (options, cb: (res: IncomingMessage) => void) => {
      seen.push(options);
      // The test transport swaps the pinned public IP for the local fixture and drops TLS.
      return httpRequest({ ...options, hostname: "127.0.0.1", port: fx.port }, cb);
    },
    timeoutMs: 500,
  });
  try {
    const res = await pinned("https://cimd.example/doc.json", {
      method: "GET",
      headers: new Headers({ accept: "application/json", "user-agent": "" }),
      redirect: "manual",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "max-age=120");
    const body = (await res.json()) as { client_id: string; host: string };
    assert.equal(body.client_id, "https://cimd.example/doc.json");
    assert.equal(body.host, "cimd.example", "Host header carries the original hostname");
    const opts = seen[0];
    assert.ok(opts);
    assert.equal(opts.hostname, PUBLIC_IP, "socket goes to the pinned address");
    assert.equal(opts.port, 443);
    assert.equal(opts.servername, "cimd.example", "SNI is the original hostname");
    assert.equal((opts.headers as Record<string, string>).host, "cimd.example");
    assert.equal((opts.headers as Record<string, string>).accept, "application/json");

    const redirected = await pinned("https://cimd.example/redirect");
    assert.equal(redirected.status, 302);
    assert.equal(fx.hits.get("/target"), undefined, "redirect target never requested");

    const empty = await pinned("https://cimd.example/empty");
    assert.equal(empty.status, 204);

    await assert.rejects(pinned("https://cimd.example/big"), (err: unknown) => err instanceof HttpError && /too large/.test(err.message));
    await assert.rejects(pinned("https://cimd.example/slow", { signal: AbortSignal.timeout(50) }), (err: unknown) =>
      err instanceof HttpError && /aborted|timed out/.test(err.message),
    );
  } finally {
    await fx.close();
  }
});

test("pinned fetch refuses plain http, credentials, and hosts that resolve to blocked ranges", async () => {
  let transportCalls = 0;
  const blocked = createPinnedFetch({
    resolve: async () => ["10.0.0.5"],
    request: () => {
      transportCalls += 1;
      throw new Error("must not connect");
    },
  });
  await assert.rejects(blocked("https://internal.example/x"), (err: unknown) => err instanceof HttpError && err.status === 400);
  const mixed = createPinnedFetch({
    resolve: async () => [PUBLIC_IP, "169.254.169.254"],
    request: () => {
      transportCalls += 1;
      throw new Error("must not connect");
    },
  });
  await assert.rejects(mixed("https://mixed.example/x"), (err: unknown) => err instanceof HttpError && err.status === 400);
  await assert.rejects(mixed("http://mixed.example/x"), (err: unknown) => err instanceof HttpError && /https/.test(err.message));
  await assert.rejects(mixed("https://user:pw@mixed.example/x"), (err: unknown) => err instanceof HttpError && /Credentials/.test(err.message));
  assert.equal(transportCalls, 0);
  // The default resolver applies the hostname rules from ssrf.ts before any DNS.
  const real = createPinnedFetch({
    request: () => {
      transportCalls += 1;
      throw new Error("must not connect");
    },
  });
  await assert.rejects(real("https://localhost/x"), (err: unknown) => err instanceof HttpError && err.status === 400);
  await assert.rejects(real("https://metadata.google.internal/x"), (err: unknown) => err instanceof HttpError && err.status === 400);
  assert.equal(transportCalls, 0);
});

const CIMD_ID = "https://cimd.example/oauth/client.json";
const CIMD_REDIRECT = "https://cimd.example/callback";

function cimdFetch(docs: Record<string, unknown>, calls: string[]) {
  return async (input: string | URL, options: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    assert.equal(options.redirect, "manual");
    const doc = docs[url];
    if (doc === undefined) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "max-age=60" },
    });
  };
}

test("CIMD: an https client_id resolves through the metadata document and completes the code flow", async () => {
  const calls: string[] = [];
  const docs: Record<string, unknown> = {
    [CIMD_ID]: {
      client_id: CIMD_ID,
      client_name: "CIMD Agent",
      redirect_uris: [CIMD_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      logo_uri: "https://cimd.example/logo.png",
    },
    "https://mismatch.example/client.json": {
      client_id: "https://someone-else.example/client.json",
      redirect_uris: ["https://mismatch.example/cb"],
      token_endpoint_auth_method: "none",
    },
    "https://badscheme.example/client.json": {
      client_id: "https://badscheme.example/client.json",
      redirect_uris: ["com.evil.app://cb"],
      token_endpoint_auth_method: "none",
    },
  };
  const srv = await startOauthServer({ secure: true, deployPlane: "staging", fetchImpl: cimdFetch(docs, calls) });
  try {
    const op = await srv.signInReady("cimd@example.com");
    const { verifier, challenge } = pkce();
    const leg = await srv.authorizeWithConsent({ jar: op.jar, clientId: CIMD_ID, redirectUri: CIMD_REDIRECT, challenge });
    assert.match(leg.consentHtml, /consent-client">CIMD Agent</);
    assert.match(leg.consentHtml, /consent-hosts"[\s\S]*cimd\.example/);
    assert.doesNotMatch(leg.consentHtml, /logo\.png/);
    assert.equal(leg.location.origin + leg.location.pathname, CIMD_REDIRECT);
    const issued = await srv.token({
      grant_type: "authorization_code",
      code: leg.code,
      redirect_uri: CIMD_REDIRECT,
      client_id: CIMD_ID,
      code_verifier: verifier,
      resource: AUDIENCE,
    });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const listed = await srv.mcp(String(issued.body.access_token), "tools/list");
    assert.equal(listed.status, 200);
    const vaultClient = (await srv.store.listClients(op.orgId)).find((c) => c.oauthClientId === CIMD_ID);
    assert.equal(vaultClient?.name, "CIMD Agent");
    assert.equal(calls.filter((u) => u === CIMD_ID).length, 1, "document fetched once, then served from the engine cache");

    const meta = (await (await srv.go("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    assert.equal(meta.client_id_metadata_document_supported, true);

    const authorizeFor = (clientId: string, redirect: string) =>
      srv.go(
        `/oauth/authorize?${new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirect,
          response_type: "code",
          scope: "openid mcp",
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
          resource: AUDIENCE,
        })}`,
        { headers: { accept: "text/html" } },
      );
    const mismatch = await authorizeFor("https://mismatch.example/client.json", "https://mismatch.example/cb");
    const mismatchHtml = await mismatch.text();
    assert.equal(mismatch.status, 400, mismatchHtml);
    assert.match(mismatchHtml, /data-testid="oauth-error"/);
    assert.match(mismatchHtml, /oauth-error-code">invalid_client_metadata</);
    const badScheme = await authorizeFor("https://badscheme.example/client.json", "com.evil.app://cb");
    assert.equal(badScheme.status, 400);
    assert.match(await badScheme.text(), /oauth-error-code">invalid_client_metadata</);
    const missing = await authorizeFor("https://missing.example/client.json", "https://missing.example/cb");
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /oauth-error-code">invalid_client</);
  } finally {
    await srv.close();
  }
});
