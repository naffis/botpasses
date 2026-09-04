/** Rate and concurrency gates on the OAuth server, and the request handler's settlement. */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { test } from "node:test";
import {
  CimdGate,
  DEVICE_ATTEMPTS_PER_WINDOW,
  assertDeviceAttempt,
  handleOauth,
} from "../src/hosted/oauth-as.ts";
import { HttpError } from "../src/hosted/errors.ts";
import { IpWindowLimiter } from "../src/hosted/identity-limiter.ts";
import { AUDIENCE, Jar, pkce, startOauthServer } from "./oauth-helpers.ts";

const NOW = 1_800_000_000_000;

test("O3 CimdGate caps fetches per target host, per requesting IP, and in flight", async () => {
  const gate = new CimdGate({ perHostPerHour: 3, perIpPerHour: 5, maxInFlight: 2 });
  // Per host: three fetches of documents on one host, from distinct IPs, then refused.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(gate.allow(`https://one.example/c${i}.json`, `10.0.0.${i}`, NOW), true, `host fetch ${i}`);
  }
  assert.equal(gate.allow("https://one.example/c9.json", "10.0.0.9", NOW), false, "fourth fetch to the host refused");
  assert.equal(gate.allow("https://two.example/c.json", "10.0.0.9", NOW), true, "another host is fine");
  // Per IP: one requester spraying distinct hosts is cut off at the IP budget.
  let allowed = 0;
  for (let i = 0; i < 10; i += 1) {
    if (gate.allow(`https://spray-${i}.example/c.json`, "203.0.113.7", NOW)) allowed += 1;
  }
  assert.equal(allowed, 5);
  assert.equal(gate.allow("https://spray-x.example/c.json", "203.0.113.8", NOW), true, "another IP unaffected");
  // Windows slide: the same IP is allowed again an hour later.
  assert.equal(gate.allow("https://spray-y.example/c.json", "203.0.113.7", NOW + 60 * 60 * 1000 + 1), true);
  // An invalid client_id URL still consumes a bucket rather than bypassing the gate.
  assert.equal(gate.allow("not a url", "203.0.113.9", NOW), true);
  assert.equal(gate.allow("not a url", "203.0.113.9", NOW), true);
  assert.equal(gate.allow("still not", "203.0.113.9", NOW), true);
  assert.equal(gate.allow("nope", "203.0.113.9", NOW), false, "invalid ids share one host bucket");

  // In flight: a wrapped fetch refuses the (max + 1)th concurrent call and releases on settle.
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped = gate.wrap(async () => {
    await blocked;
    return new Response("{}", { status: 200 });
  });
  const a = wrapped("https://a.example/doc");
  const b = wrapped("https://b.example/doc");
  assert.equal(gate.inFlight, 2);
  await assert.rejects(wrapped("https://c.example/doc"), (err: unknown) => err instanceof HttpError && err.status === 503);
  release?.();
  assert.equal((await a).status, 200);
  assert.equal((await b).status, 200);
  assert.equal(gate.inFlight, 0);
  const failing = gate.wrap(async () => {
    throw new Error("upstream");
  });
  await assert.rejects(failing("https://d.example/doc"), /upstream/);
  assert.equal(gate.inFlight, 0, "a failed fetch releases its slot");
});

test("O3 the provider refuses a metadata fetch once the requester's IP budget is spent", async () => {
  const calls: string[] = [];
  const docFor = (id: string) => ({
    client_id: id,
    client_name: "Sprayer",
    redirect_uris: ["https://cb.example/cb"],
    token_endpoint_auth_method: "none",
  });
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify(docFor(url)), { status: 200, headers: { "content-type": "application/json" } });
  };
  const srv = await startOauthServer({
    secure: true,
    deployPlane: "staging",
    fetchImpl,
    cimdGate: new CimdGate({ perIpPerHour: 2, perHostPerHour: 100 }),
  });
  try {
    const authorize = async (host: string) =>
      srv.go(
        `/oauth/authorize?${new URLSearchParams({
          client_id: `https://${host}/client.json`,
          redirect_uri: "https://cb.example/cb",
          response_type: "code",
          scope: "openid mcp",
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
          resource: AUDIENCE,
        })}`,
        { headers: { accept: "text/html" } },
      );
    assert.equal((await authorize("first.example")).status, 303);
    assert.equal((await authorize("second.example")).status, 303);
    const third = await authorize("third.example");
    const html = await third.text();
    assert.equal(third.status, 400, html);
    assert.match(html, /oauth-error-code">invalid_client</);
    assert.equal(calls.length, 2, "the third document was never fetched");
  } finally {
    await srv.close();
  }
});

function fakeRequest(ip: string, cookie?: string): IncomingMessage {
  return {
    headers: cookie ? { cookie } : {},
    socket: { remoteAddress: ip },
  } as unknown as IncomingMessage;
}

test("O4 POST /device attempts are limited per IP and per OP session", () => {
  const limiter = new IpWindowLimiter();
  for (let i = 0; i < DEVICE_ATTEMPTS_PER_WINDOW; i += 1) assertDeviceAttempt(fakeRequest("198.51.100.1"), limiter);
  assert.throws(() => assertDeviceAttempt(fakeRequest("198.51.100.1"), limiter), (err: unknown) => err instanceof HttpError && err.status === 429);
  assertDeviceAttempt(fakeRequest("198.51.100.2"), limiter);
  // One OP session hopping across addresses still gets one budget.
  for (let i = 0; i < DEVICE_ATTEMPTS_PER_WINDOW; i += 1) {
    assertDeviceAttempt(fakeRequest(`192.0.2.${i + 10}`, "_session=abc.def; other=1"), limiter);
  }
  assert.throws(
    () => assertDeviceAttempt(fakeRequest("192.0.2.99", "_session=abc.def"), limiter),
    (err: unknown) => err instanceof HttpError && err.status === 429,
  );
  assertDeviceAttempt(fakeRequest("192.0.2.98", "_session=other"), limiter);
});

test("O4 the server answers 429 to a device-code guessing loop", async () => {
  const srv = await startOauthServer({ secure: true, deployPlane: "staging" });
  try {
    const jar = new Jar();
    const page = await srv.go("/device", { jar });
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const statuses: number[] = [];
    for (let i = 0; i < DEVICE_ATTEMPTS_PER_WINDOW + 2; i += 1) {
      const res = await srv.go("/device", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
        body: new URLSearchParams({ xsrf, user_code: String(100000000 + i) }),
        jar,
      });
      statuses.push(res.status);
      await res.text();
    }
    assert.deepEqual(statuses.slice(0, DEVICE_ATTEMPTS_PER_WINDOW).filter((s) => s === 429), [], "the window's attempts reach the engine");
    assert.deepEqual(statuses.slice(DEVICE_ATTEMPTS_PER_WINDOW), [429, 429], "attempts past the window are refused");
  } finally {
    await srv.close();
  }
});

test("O11 handleOauth settles once oidc-provider has answered", async () => {
  const srv = await startOauthServer({ secure: true, deployPlane: "staging" });
  let settled = false;
  const relay = createServer((req, res) => {
    void handleOauth(srv.oidcProvider, req, res)
      .then(() => {
        settled = true;
      })
      .catch(() => {
        settled = true;
      });
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const addr = relay.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/oauth/jwks`, { headers: { "x-forwarded-proto": "https" } });
    assert.equal(res.status, 200);
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, true, "the handler promise resolved after the response");
  } finally {
    await new Promise<void>((resolve, reject) => relay.close((err) => (err ? reject(err) : resolve())));
    await srv.close();
  }
});
