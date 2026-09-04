/**
 * Connector hardening (2026-09-04 audit, W3): a closed socket never hangs a call, origin bodies
 * are capped on the wire, the request path is canonical in every layer, redaction covers the
 * encodings an origin echoes, the target parser refuses what the connector cannot send, and the
 * cookie MCP path needs a ready operator.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import {
  BODY_TOO_LARGE,
  executeConnector,
  fetchPinned,
  hostAllowedBy,
  isOriginUnreachable,
  RAW_RESPONSE_CAP,
  redactConnectorBody,
  type ConnectorItem,
} from "../src/hosted/connector.ts";
import { isHttpError } from "../src/hosted/errors.ts";
import { mcpModelPrincipal } from "../src/hosted/http-mcp-routes.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { scopeDenialReason } from "../src/hosted/kernel-grant-scope.ts";
import { connectorTargetFromArgs, sendNeverLeft } from "../src/hosted/mcp-http.ts";
import { canonicalRequestPath, hasDotSegments } from "../src/hosted/ssrf.ts";
import { suggestedNameFromHost } from "../src/ids.ts";
import { secretEncodings } from "../src/redact.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";
import { PINNED_HOST as HOST, selfSigned } from "./helpers/self-signed.ts";

function item(secret: string, inject = "bearer", username: string | null = null): ConnectorItem {
  return { secret, username, last4: secret.slice(-4), inject, allowedHosts: [HOST, "api.echo.example"], name: "ECHO", kind: "secret" };
}

type Behaviour = "partial_then_destroy" | "huge_chunked" | "huge_declared" | "echo";

async function tlsServer(dir: string, behaviour: Behaviour): Promise<{ server: Server; port: number; cert: Buffer }> {
  const { key, cert } = selfSigned(dir);
  const server = createServer({ key, cert }, (req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      switch (behaviour) {
        case "partial_then_destroy":
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"partial":');
          setTimeout(() => res.destroy(), 20);
          return;
        case "huge_chunked": {
          // A pagination header that echoes the request URL, as APIs with `query:` keys do.
          res.writeHead(200, { "content-type": "text/plain", link: `<https://${HOST}${req.url}&page=2>; rel="next"` });
          const chunk = Buffer.alloc(256 * 1024, "x");
          for (let i = 0; i < 20; i += 1) res.write(chunk);
          res.end();
          return;
        }
        case "huge_declared":
          res.writeHead(200, { "content-type": "text/plain", "content-length": String(5 * 1024 * 1024) });
          res.write("y".repeat(1024));
          return;
        case "echo":
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ path: req.url }));
          return;
        default: {
          const _exhaustive: never = behaviour;
          throw new Error(String(_exhaustive));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, cert };
}

async function pinned(behaviour: Behaviour, run: (opts: { ca: Buffer; port: number }) => Promise<void>): Promise<void> {
  const dir = tempHome();
  const { server, port, cert } = await tlsServer(dir, behaviour);
  try {
    await run({ ca: cert, port });
  } finally {
    server.closeAllConnections();
    server.close();
    cleanup(dir);
  }
}

/** `fetchPinned` against the local TLS origin (the SSRF check keeps `executeConnector` off loopback). */
function dial(tls: { ca: Buffer; port: number }, path: string, signal = new AbortController().signal) {
  return fetchPinned(`https://${HOST}${path}`, { method: "GET", headers: { authorization: `Bearer ${CANARY}` }, signal, addresses: ["127.0.0.1"], ...tls, timeoutMs: 5000 });
}

test("C1: an origin that closes the socket mid-body fails the call promptly as a sent-but-unanswered request", async () => {
  await pinned("partial_then_destroy", async (tls) => {
    const started = Date.now();
    await assert.rejects(
      () => dial(tls, "/v1/thing"),
      (err: unknown) => {
        const rec = err as { code?: string; credentialSent?: boolean; message: string };
        assert.equal(rec.code, "ERR_STREAM_PREMATURE_CLOSE");
        assert.equal(rec.credentialSent, true, "the request was on the wire");
        assert.ok(!rec.message.includes(CANARY));
        return true;
      },
    );
    assert.ok(Date.now() - started < 4000, "the call did not wait for the deadline");
  });
  // Through the connector the same failure is a 502 that keeps a one-call approval spent.
  await assert.rejects(
    () =>
      executeConnector(
        item(CANARY),
        { method: "GET", path: "/v1/thing" },
        {
          resolveAddresses: async () => ["8.8.8.8"],
          fetchImpl: async () => {
            throw Object.assign(new Error("premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE", credentialSent: true });
          },
        },
      ),
    (err: unknown) => {
      assert.ok(isOriginUnreachable(err), "typed as unreachable");
      assert.equal(err.status, 502);
      assert.match(err.message, /closed the connection before the response completed/);
      assert.equal(err.credentialSent, true);
      assert.equal(sendNeverLeft(err), false, "so a one-call approval stays spent");
      return true;
    },
  );
  // Whereas a failure before the handshake hands it back.
  await assert.rejects(
    () =>
      executeConnector(
        item(CANARY),
        { method: "GET", path: "/v1/thing" },
        {
          resolveAddresses: async () => ["8.8.8.8"],
          fetchImpl: async () => {
            throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
          },
        },
      ),
    (err: unknown) => isOriginUnreachable(err) && err.credentialSent === false && sendNeverLeft(err),
  );
});

test("C2: origin bodies past 1 MiB are cut on the wire and reported as body_too_large, declared or chunked, pinned or not", async () => {
  await pinned("huge_chunked", async (tls) => {
    await assert.rejects(
      () => dial(tls, `/big?api_key=${CANARY}`),
      (err: unknown) => {
        assert.ok(err instanceof Error && err.message === BODY_TOO_LARGE && err.name === "OriginBodyTooLarge");
        const headers = (err as Error & { headers: Record<string, string> }).headers;
        assert.ok(headers.link?.includes(CANARY), "the pinned path hands the raw headers to the connector, which redacts them");
        return true;
      },
    );
  });
  await pinned("huge_declared", async (tls) => {
    const started = Date.now();
    await assert.rejects(() => dial(tls, "/big"), (err: unknown) => err instanceof Error && err.message === BODY_TOO_LARGE);
    assert.ok(Date.now() - started < 4000, "a declared oversize body is refused without reading it");
  });
  let seenEncoding = "";
  // R3-2: the body_too_large result carries origin headers, so they are redacted like any other
  // answer's; here a Link header echoes the `query:` key.
  const out = await executeConnector(
    item(CANARY, "query:api_key"),
    { method: "GET", path: "/big" },
    {
      resolveAddresses: async () => ["8.8.8.8"],
      fetchImpl: async (url, init) => {
        seenEncoding = new Headers(init?.headers).get("accept-encoding") ?? "";
        return new Response("z".repeat(RAW_RESPONSE_CAP + 1), {
          status: 200,
          headers: { link: `<${String(url)}&page=2>; rel="next"`, "x-request-id": Buffer.from(CANARY).toString("base64") },
        });
      },
    },
  );
  assert.equal(out.status, 502);
  assert.match(out.body, new RegExp(BODY_TOO_LARGE));
  assert.equal(seenEncoding, "identity", "no compressed bodies that expand past the cap in memory");
  assert.ok(!JSON.stringify(out).includes(CANARY), "the echoed key is redacted from body_too_large headers");
  assert.ok(!JSON.stringify(out).includes(Buffer.from(CANARY).toString("base64")), "and so is its base64 form");
  assert.equal(out.headers.link, `<https://${HOST}/big?api_key=[redacted]&page=2>; rel="next"`);
  assert.equal(out.headers["x-request-id"], "[redacted]");
  // The same for a declared oversize body, which is refused before the stream is read.
  const declared = await executeConnector(
    item(CANARY, "query:api_key"),
    { method: "GET", path: "/big" },
    {
      resolveAddresses: async () => ["8.8.8.8"],
      fetchImpl: async (url) =>
        new Response("y", { status: 200, headers: { "content-length": String(5 * 1024 * 1024), link: `<${String(url)}>; rel="self"` } }),
    },
  );
  assert.equal(declared.status, 502);
  assert.ok(!JSON.stringify(declared).includes(CANARY));
  const fits = await executeConnector(
    item(CANARY),
    { method: "GET", path: "/ok" },
    { resolveAddresses: async () => ["8.8.8.8"], fetchImpl: async () => new Response("z".repeat(RAW_RESPONSE_CAP), { status: 200 }) },
  );
  assert.equal(fits.status, 200, "exactly the cap still passes (then the 256 KiB text cut applies)");
});

test("C3/G1: one canonical request path for validation, scope, storage, and the wire", async () => {
  const rejected = [
    "/v1/read/..%2fadmin",
    "/v1/read/%2e%2e%2fadmin",
    "/v1/read/%2E%2E/admin",
    "/v1/read/..;/admin",
    "/v1/read/../admin",
    "/v1/read\\admin",
    "/v1/read/%5cadmin",
    "/v1/%2Ehidden",
    "/v1/a%2fb",
    "/v1/read/.;x/y",
    "/v1/%zz",
    "/v1/a b",
    "/v1/x#frag",
    "//evil.example/x",
    "v1/read",
    // R3-4: double (and deeper) percent-encoding an origin decodes again, and NUL in any form.
    "/v1/read/%252e%252e/admin",
    "/v1/read/..%252fadmin",
    "/v1/read/%252fadmin",
    "/v1/read/%25252Fadmin",
    "/v1/read/%25255Cadmin",
    "/v1/read/%252Ehidden",
    "/v1/read/..%00/admin",
    "/v1/read/x%00y",
    "/v1/read/x%2500y",
    "/v1/read/x?q=%00",
    "/v1/read/a\u0000b",
    "/v1/read/a\u0001b",
    "/v1/read/a\u007fb",
  ];
  for (const p of rejected) {
    assert.throws(() => canonicalRequestPath(p), (e: unknown) => isHttpError(e) && e.status === 400, p);
    assert.ok(hasDotSegments(p), p);
  }
  // A literal percent sign that does not encode a separator, dot, or NUL is still fine.
  assert.equal(canonicalRequestPath("/v1/discount/100%25"), "/v1/discount/100%25");
  assert.equal(canonicalRequestPath("/v1/read/%2541"), "/v1/read/%2541");
  assert.equal(canonicalRequestPath("/v1/read/items?page=2&q=a%20b"), "/v1/read/items?page=2&q=a%20b");
  assert.equal(canonicalRequestPath("/v1/%7Bid%7D/x"), "/v1/%7Bid%7D/x");
  assert.equal(canonicalRequestPath("/a.b/c..d/"), "/a.b/c..d/");
  assert.equal(canonicalRequestPath("  /v1/x  "), "/v1/x");
  assert.equal(canonicalRequestPath("/v1/caf%C3%A9"), "/v1/caf%C3%A9");

  const scope = { methods: null, hosts: null, pathPrefixes: ["/v1/read"], maxCalls: null, callsUsed: 0 };
  for (const p of ["/v1/read/..%2fadmin", "/v1/read/%2e%2e%2fadmin", "/v1/read/..;/admin", "/v1/read\\..\\admin", "/v1/read%2f..%2fadmin"]) {
    assert.equal(scopeDenialReason(scope, { host: "a", method: "GET", path: p }), "path", p);
  }
  assert.equal(scopeDenialReason(scope, { host: "a", method: "GET", path: "/v1/read/%7Bid%7D?x=1" }), undefined);

  // The parser hands back the canonical form, and the wire carries exactly that string.
  const target = connectorTargetFromArgs({ host: HOST, method: "get", path: "/v1/read/%7Bid%7D?q=a%20b" });
  assert.equal(target.path, "/v1/read/%7Bid%7D?q=a%20b");
  assert.throws(() => connectorTargetFromArgs({ host: HOST, method: "GET", path: "/v1/read/..%2fadmin" }), (e: unknown) => isHttpError(e) && e.status === 400);
  assert.throws(() => connectorTargetFromArgs({ host: HOST, method: "GET", path: `https://${HOST}/v1/read/..;/admin` }), (e: unknown) => isHttpError(e) && e.status === 400);
  await pinned("echo", async (tls) => {
    const res = await dial(tls, target.path);
    assert.equal((JSON.parse(res.body.toString("utf8")) as { path: string }).path, target.path);
  });
  let wire = "";
  await executeConnector(
    item(CANARY),
    { method: "GET", path: target.path },
    {
      resolveAddresses: async () => ["8.8.8.8"],
      fetchImpl: async (url) => {
        wire = String(url);
        return new Response("{}", { status: 200 });
      },
    },
  );
  assert.equal(wire, `https://${HOST}${target.path}`);

  // The kernel stores the canonical path on the grant the operator sees.
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), publicUrl: "http://127.0.0.1:8788", deployPlane: "staging" });
  try {
    const { orgId } = await kernel.createOrg("acme", "user_owner");
    await kernel.createItem({ orgId, actor: "user_owner", environment: "staging", kind: "secret", name: "K", value: CANARY, allowedHosts: [HOST], inject: "bearer" });
    const { client } = await kernel.createModelClient({ orgId, name: "m", environment: "staging" });
    const asked = await kernel.requestGrant({ orgId, clientId: client.id, itemName: "K", environment: "staging", request: { host: HOST, method: "GET", path: " /v1/read/%7Bid%7D?x=1 " } });
    assert.equal(asked.grant.requestedScope?.path, "/v1/read/%7Bid%7D?x=1");
    await assert.rejects(
      () => kernel.requestGrant({ orgId, clientId: client.id, itemName: "K", environment: "staging", request: { host: HOST, method: "GET", path: "/v1/read/..%2fadmin" } }),
      (e: unknown) => isHttpError(e) && e.status === 400 && /^path /.test(e.message),
    );
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("C6: redaction covers lowercase percent-encoding, form `+` encoding, HTML entities, and the Basic pair under the client id actually sent", () => {
  const secret = "p@ss w'rd/<&>+=2026_secret_value";
  const forms = secretEncodings(secret, "stored_user");
  const lower = encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  assert.ok(forms.includes(lower), "lowercase percent form");
  assert.ok(forms.includes(new URLSearchParams({ v: secret }).toString().slice(2)), "form body `+` form");
  assert.ok(forms.includes("p@ss w&#39;rd/&lt;&amp;&gt;+=2026_secret_value"), "HTML entities");
  assert.ok(forms.includes("p@ss w&#x27;rd/&lt;&amp;&gt;+=2026_secret_value"), "HTML entities, hex apostrophe");
  const echoed = [
    `a=${lower}`,
    `<input value="${"p@ss w&#39;rd/&lt;&amp;&gt;+=2026_secret_value"}">`,
    `basic ${Buffer.from(`sent_as_this:${secret}`).toString("base64")}`,
    `stored ${Buffer.from(`stored_user:${secret}`).toString("base64")}`,
  ].join("\n");
  const out = redactConnectorBody(echoed, item(secret, "basic", "stored_user"), [], undefined, "sent_as_this");
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes(lower));
  assert.ok(!out.includes(Buffer.from(`sent_as_this:${secret}`).toString("base64")), "Basic pair under the client_id sent");
  assert.ok(!out.includes(Buffer.from(`stored_user:${secret}`).toString("base64")), "Basic pair under the stored username");
  assert.ok(!out.includes("&#39;rd"));
  assert.equal((out.match(/\[redacted\]/g) ?? []).length, 4);
});

test("C8: content_type is one of two values and ports other than 443 are refused with a hint", () => {
  assert.throws(() => connectorTargetFromArgs({ host: HOST, method: "GET", path: "/", content_type: "text/plain" }), (e: unknown) => isHttpError(e) && e.status === 400 && /content_type must be/.test(e.message));
  assert.equal(connectorTargetFromArgs({ host: HOST, method: "GET", path: "/", content_type: "Application/JSON; charset=utf-8" }).contentType, "application/json");
  for (const args of [
    { host: HOST, method: "GET", path: `https://${HOST}:8443/v1` },
    { host: `${HOST}:8443`, method: "GET", path: "/v1" },
    { host: `https://${HOST}:8080/v1`, method: "GET", path: "/" },
  ]) {
    assert.throws(() => connectorTargetFromArgs(args), (e: unknown) => isHttpError(e) && e.status === 400 && /port .* is not supported/.test(e.message) && /443/.test(e.message), JSON.stringify(args));
  }
  assert.equal(connectorTargetFromArgs({ host: HOST, method: "GET", path: `https://${HOST}:443/v1` }).host, HOST, "an explicit :443 is the default");
});

test("C12: host membership is case-insensitive for rows stored before lowercasing", () => {
  assert.equal(hostAllowedBy(["API.Example.com"], "api.example.com"), true);
  assert.equal(hostAllowedBy(["api.example.com"], " API.EXAMPLE.COM "), true);
  assert.equal(hostAllowedBy(["api.example.com"], "api.example.co"), false);
});

test("C17: suggestedNameFromHost yields a valid name for every host", () => {
  assert.equal(suggestedNameFromHost("api.example.com"), "API_EXAMPLE_COM");
  assert.equal(suggestedNameFromHost("api-v2.example.com"), "API_V2_EXAMPLE_COM");
  assert.equal(suggestedNameFromHost("1password.com"), "H_1PASSWORD_COM");
  assert.equal(suggestedNameFromHost("xn--bcher-kva.example"), "XN_BCHER_KVA_EXAMPLE");
  assert.equal(suggestedNameFromHost("..api..example.."), "API_EXAMPLE");
  assert.equal(suggestedNameFromHost(""), undefined);
  assert.equal(suggestedNameFromHost("---"), undefined);
  assert.equal(suggestedNameFromHost(`${"a".repeat(200)}.com`)?.length, 120);
});

test("B5: an operator session that has not passed the authenticator step cannot drive MCP as a model", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), publicUrl: "http://127.0.0.1:8788", deployPlane: "staging" });
  try {
    const { orgId } = await kernel.createOrg("acme", "user_owner");
    const pending = { channel: "operator" as const, userId: "user_owner", orgId, role: "owner" as const, ready: false, needs_totp: true, sessionHash: "h" };
    await assert.rejects(() => mcpModelPrincipal(kernel, pending, "staging"), (e: unknown) => isHttpError(e) && e.status === 403 && e.message === "mfa_required" && e.extra.verify_url === "/verify-totp");
    await assert.rejects(() => mcpModelPrincipal(kernel, { ...pending, ready: true, orgId: "" }, "staging"), (e: unknown) => isHttpError(e) && e.status === 403 && /Organization required/.test(e.message));
    assert.equal((await kernel.store.listClients(orgId)).length, 0, "no stdio client was provisioned for a refused session");
    const ready = await mcpModelPrincipal(kernel, { ...pending, ready: true }, "staging");
    assert.equal(ready.channel, "model");
    assert.equal(ready.orgId, orgId);
  } finally {
    await store.close();
    cleanup(home);
  }
});
