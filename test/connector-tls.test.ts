/**
 * The production network path: fetchPinned dials the resolved IP, presents the hostname for SNI
 * and Host, verifies the certificate against the injected CA, honours abort, and returns 3xx
 * without following it. Uses a self-signed certificate generated per run with openssl.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { describeOriginFailure, fetchPinned } from "../src/hosted/connector.ts";
import { isHttpError } from "../src/hosted/errors.ts";
import { cleanup, tempHome } from "./helpers.ts";
import { PINNED_HOST as HOST, selfSigned } from "./helpers/self-signed.ts";

type Seen = { host?: string; servername?: string; path?: string; method?: string; body: string };

async function tlsServer(dir: string, behaviour: "echo" | "redirect" | "hang"): Promise<{ server: Server; port: number; cert: Buffer; seen: Seen }> {
  const { key, cert } = selfSigned(dir);
  const seen: Seen = { body: "" };
  const server = createServer(
    {
      key,
      cert,
      SNICallback: (servername, cb) => {
        seen.servername = servername;
        cb(null, undefined);
      },
    },
    (req, res) => {
      seen.host = req.headers.host;
      seen.path = req.url;
      seen.method = req.method;
      req.on("data", (c: Buffer) => {
        seen.body += c.toString();
      });
      req.on("end", () => {
        if (behaviour === "hang") return;
        if (behaviour === "redirect") {
          res.writeHead(302, { location: `https://${HOST}/elsewhere`, "content-type": "text/plain" });
          res.end("moved");
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json",
          link: '<https://api.pinned.test/v1/thing?page=2>; rel="next"',
          "x-ratelimit-remaining": "9",
          "set-cookie": "sid=never-forwarded",
        });
        res.end(JSON.stringify({ host: req.headers.host, auth: req.headers.authorization ?? null }));
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, cert, seen };
}

test("fetchPinned dials the pinned IP with the hostname as SNI and Host, and verifies the CA", async () => {
  const dir = tempHome();
  const { server, port, cert, seen } = await tlsServer(dir, "echo");
  try {
    const res = await fetchPinned(`https://${HOST}/v1/thing?q=1`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      signal: new AbortController().signal,
      addresses: ["127.0.0.1"],
      ca: cert,
      port,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("link"), '<https://api.pinned.test/v1/thing?page=2>; rel="next"', "origin headers are forwarded");
    assert.equal(res.headers.get("x-ratelimit-remaining"), "9");
    const body = (await res.json()) as { host: string; auth: string };
    assert.equal(body.host, HOST, "Host header is the hostname, not the IP");
    assert.equal(body.auth, "Bearer not-a-real-token");
    assert.equal(seen.servername, HOST, "SNI is the hostname");
    assert.equal(seen.path, "/v1/thing?q=1");
    assert.equal(seen.method, "POST");
    assert.equal(seen.body, '{"a":1}');
    await assert.rejects(
      () =>
        fetchPinned(`https://${HOST}/v1/thing`, {
          method: "GET",
          headers: {},
          signal: new AbortController().signal,
          addresses: ["127.0.0.1"],
          port,
        }),
      (err: unknown) => {
        const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
        return code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN";
      },
      "without the CA the self-signed certificate is rejected",
    );
  } finally {
    server.close();
    cleanup(dir);
  }
});

test("fetchPinned returns a 3xx as-is and never follows Location", async () => {
  const dir = tempHome();
  const { server, port, cert, seen } = await tlsServer(dir, "redirect");
  try {
    const res = await fetchPinned(`https://${HOST}/old`, {
      method: "GET",
      headers: {},
      signal: new AbortController().signal,
      addresses: ["127.0.0.1"],
      ca: cert,
      port,
    });
    assert.equal(res.status, 302);
    assert.equal(await res.text(), "moved");
    assert.equal(seen.path, "/old", "only the original path was requested");
  } finally {
    server.close();
    cleanup(dir);
  }
});

test("fetchPinned aborts a hung origin and reports a timeout without the request", async () => {
  const dir = tempHome();
  const { server, port, cert } = await tlsServer(dir, "hang");
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(
      () =>
        fetchPinned(`https://${HOST}/slow`, {
          method: "GET",
          headers: { authorization: "Bearer secret-value-never-shown" },
          signal: ac.signal,
          addresses: ["127.0.0.1"],
          ca: cert,
          port,
          timeoutMs: 3000,
        }),
      (err: unknown) =>
        isHttpError(err) &&
        err.status === 502 &&
        /did not respond within 3s/.test(err.message) &&
        !err.message.includes("secret-value-never-shown"),
    );
  } finally {
    server.closeAllConnections();
    server.close();
    cleanup(dir);
  }
});

test("describeOriginFailure names DNS, TLS, connection, and timeout causes without the request", () => {
  const dns = describeOriginFailure(Object.assign(new Error("getaddrinfo ENOTFOUND api.x"), { code: "ENOTFOUND" }), "api.x", false);
  assert.match(dns, /DNS lookup for api\.x failed \(ENOTFOUND\)/);
  const tls = describeOriginFailure(Object.assign(new Error("self signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "api.x", false);
  assert.match(tls, /TLS handshake with api\.x failed/);
  const conn = describeOriginFailure(Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" }), "api.x", false);
  assert.match(conn, /could not connect to api\.x \(ECONNREFUSED\)/);
  assert.doesNotMatch(conn, /1\.2\.3\.4/);
  assert.match(describeOriginFailure(undefined, "api.x", true), /did not respond within 10s/);
  assert.equal(describeOriginFailure(new Error("Authorization: Bearer leak"), "api.x", false), "Origin request failed: api.x");
});
