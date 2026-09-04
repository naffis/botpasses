/**
 * Every InjectMode against an origin that echoes what it received (3.3). Each mode lands the
 * credential where the scheme says, the echo comes back redacted, and anything that is not a mode
 * is refused (400 at store time, 500 `inject_unsupported` at send time), never sent as Bearer.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { SignatureV4 } from "@smithy/signature-v4";
import { executeConnector, type ConnectorItem } from "../src/hosted/connector.ts";
import { isHttpError } from "../src/hosted/errors.ts";
import { applyInject, parseInject, parseInjectMode } from "../src/hosted/providers/inject.ts";
import { amzDate, canonicalQuery, parseAwsHost, signV4 } from "../src/hosted/providers/sigv4.ts";
import { injectModeOf, storeRequestBody } from "../src/hosted/store-form-fields.ts";

const SECRET = "tok_CANARY_long_enough_1234567890/+=";
const NOW = new Date("2026-09-04T12:00:00Z");

type Seen = { url: string; headers: Record<string, string>; body: string };

function item(inject: string, over: Partial<ConnectorItem> = {}): ConnectorItem {
  return {
    secret: SECRET,
    username: null,
    last4: SECRET.slice(-4),
    inject,
    allowedHosts: ["api.echo.example"],
    name: "ECHO",
    kind: "secret",
    ...over,
  };
}

/** Origin that reflects URL, headers, and body so the test can see exactly what was sent. */
function echo(): { seen: Seen[]; fetchImpl: typeof fetch } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ url: String(url), headers, body });
    return new Response(JSON.stringify({ url: String(url), headers, body }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

async function send(it: ConnectorItem, req: { method?: string; path?: string; body?: unknown; contentType?: string; host?: string } = {}) {
  const { seen, fetchImpl } = echo();
  const result = await executeConnector(
    it,
    { method: req.method ?? "GET", path: req.path ?? "/v1/x", body: req.body, contentType: req.contentType, host: req.host },
    { fetchImpl, resolveAddresses: async () => ["8.8.8.8"], now: () => NOW },
  );
  const sent = seen[0];
  assert.ok(sent, "origin was called");
  assert.ok(!result.body.includes(SECRET), `${it.inject}: raw secret leaked in echo`);
  assert.ok(!result.body.includes(encodeURIComponent(SECRET)), `${it.inject}: url-encoded secret leaked`);
  assert.ok(!result.body.includes(Buffer.from(`${it.username ?? ""}:${SECRET}`).toString("base64")), `${it.inject}: basic form leaked`);
  return { result, sent };
}

test("injectModeOf: the grammar accepts every documented mode and nothing else", () => {
  for (const ok of ["bearer", "basic", "client_credentials", "refresh", "sigv4", "header:X-API-Key", "query:api_key", "cookie:session", "hmac:stripe_sig", "hmac:slack_sig", "hmac:github_sig"]) {
    assert.equal(injectModeOf(ok), ok, ok);
  }
  assert.equal(injectModeOf(" bearer "), "bearer", "whitespace is trimmed");
  for (const bad of ["", "Bearer", "token", "header:", "header:bad name", "query:a=b", "cookie:", "hmac:", "hmac:md5", "oauth", "basic:x", "sigv4:us-east-1"]) {
    assert.equal(injectModeOf(bad), null, JSON.stringify(bad));
  }
});

test("parseInjectMode is a 400 with the accepted list; storeRequestBody refuses the same strings", () => {
  assert.equal(parseInjectMode("cookie:sid"), "cookie:sid");
  assert.throws(
    () => parseInjectMode("weird"),
    (err: unknown) =>
      isHttpError(err) && err.status === 400 && /Unknown send mode "weird"/.test(err.message) && /hmac:github_sig/.test(err.message) && err.extra.status === "inject_invalid",
  );
  const values = { name: "X", kind: "secret", inject: "weird", username: "", allowedHosts: "api.example.com", value: "v" };
  assert.throws(() => storeRequestBody(values, { editing: false }), /Unknown send mode "weird"/);
  assert.equal(storeRequestBody({ ...values, inject: "query:api_key" }, { editing: false }).inject, "query:api_key");
  assert.equal(storeRequestBody({ ...values, kind: "client_secret", username: "cid" }, { editing: false }).inject, "client_credentials");
  assert.deepEqual(parseInject("hmac:slack_sig"), { kind: "hmac", scheme: "slack_sig" });
  assert.deepEqual(parseInject("query:k"), { kind: "query", param: "k" });
});

test("bearer, basic, header, query, and cookie land the secret where the scheme says", async () => {
  const bearer = await send(item("bearer"));
  assert.equal(bearer.sent.headers.authorization, `Bearer ${SECRET}`);
  assert.match(bearer.result.body, /Bearer \[redacted\]/);

  const basic = await send(item("basic", { username: "svc" }));
  assert.equal(basic.sent.headers.authorization, `Basic ${Buffer.from(`svc:${SECRET}`).toString("base64")}`);

  const login = await send(item("bearer", { kind: "login", username: "u" }));
  assert.match(login.sent.headers.authorization ?? "", /^Basic /, "login items are Basic whatever the mode");

  const header = await send(item("header:X-API-Key"));
  assert.equal(header.sent.headers["x-api-key"], SECRET);
  assert.equal(header.sent.headers.authorization, undefined);

  const query = await send(item("query:api_key"), { path: "/v1/x?a=1" });
  assert.equal(query.sent.url, `https://api.echo.example/v1/x?a=1&api_key=${encodeURIComponent(SECRET)}`);
  assert.equal(query.sent.headers.authorization, undefined);
  assert.match(query.result.body, /api_key=\[redacted\]/);

  const bare = await send(item("query:key"), { path: "/v1/x" });
  assert.equal(bare.sent.url, `https://api.echo.example/v1/x?key=${encodeURIComponent(SECRET)}`);

  const cookie = await send(item("cookie:session"));
  assert.equal(cookie.sent.headers.cookie, `session=${SECRET}`);
  assert.match(cookie.result.body, /session=\[redacted\]/);
});

test("hmac schemes sign the exact body bytes and never send the secret", async () => {
  const body = { event: "ping", n: 1 };
  const raw = JSON.stringify(body);
  const t = Math.floor(NOW.getTime() / 1000);
  const hex = (alg: "sha256" | "sha1", msg: string) => createHmac(alg, SECRET).update(msg).digest("hex");

  const stripe = await send(item("hmac:stripe_sig"), { method: "POST", body });
  assert.equal(stripe.sent.body, raw);
  assert.equal(stripe.sent.headers["stripe-signature"], `t=${t},v1=${hex("sha256", `${t}.${raw}`)}`);

  const slack = await send(item("hmac:slack_sig"), { method: "POST", body });
  assert.equal(slack.sent.headers["x-slack-request-timestamp"], String(t));
  assert.equal(slack.sent.headers["x-slack-signature"], `v0=${hex("sha256", `v0:${t}:${raw}`)}`);

  const github = await send(item("hmac:github_sig"), { method: "POST", body });
  assert.equal(github.sent.headers["x-hub-signature-256"], `sha256=${hex("sha256", raw)}`);
  assert.equal(github.sent.headers["x-hub-signature"], `sha1=${hex("sha1", raw)}`);

  const empty = await send(item("hmac:github_sig"), { method: "DELETE" });
  assert.equal(empty.sent.headers["x-hub-signature-256"], `sha256=${hex("sha256", "")}`, "no body signs the empty string");
  for (const s of [stripe, slack, github]) {
    assert.equal(s.sent.headers.authorization, undefined);
    assert.ok(!JSON.stringify(s.sent.headers).includes(SECRET));
  }
});

/** Node-crypto hash for @smithy/signature-v4 (the AWS SDK's own signer), used as an oracle. */
type SourceData = string | ArrayBuffer | ArrayBufferView;

function toBuffer(data: SourceData): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

class NodeSha256 {
  #h: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(secret?: SourceData) {
    this.#h = secret === undefined ? createHash("sha256") : createHmac("sha256", toBuffer(secret));
  }
  update(data: SourceData): void {
    this.#h.update(toBuffer(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.#h.digest());
  }
}

const AWS_KEY_ID = "AKIDEXAMPLE";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

test("signV4 reproduces the AWS get-vanilla test vector", () => {
  const signed = signV4({
    accessKeyId: AWS_KEY_ID,
    secretAccessKey: AWS_SECRET,
    method: "GET",
    path: "/",
    headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    payloadHash: createHash("sha256").update("").digest("hex"),
    region: "us-east-1",
    service: "service",
    amzDate: "20150830T123600Z",
  });
  assert.equal(
    signed.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
  assert.equal(amzDate(new Date("2015-08-30T12:36:00Z")), "20150830T123600Z");
  assert.equal(canonicalQuery("?b=2&a=1&a=%20x&Z=0"), "Z=0&a=%20x&a=1&b=2", "code-point order: '%' < '1', 'Z' < 'a'");
  assert.deepEqual(parseAwsHost("dynamodb.us-east-1.amazonaws.com"), { service: "dynamodb", region: "us-east-1" });
  assert.deepEqual(parseAwsHost("bucket.s3.eu-west-1.amazonaws.com"), { service: "s3", region: "eu-west-1" });
  assert.equal(parseAwsHost("iam.amazonaws.com"), undefined, "global endpoints are refused");
  assert.equal(parseAwsHost("api.example.com"), undefined);
});

test("sigv4 items match the AWS SDK signer and keep the secret key out of the request", async () => {
  const host = "dynamodb.us-east-1.amazonaws.com";
  const body = { TableName: "items", Limit: 1 };
  const aws = item("sigv4", { username: AWS_KEY_ID, secret: AWS_SECRET, allowedHosts: [host] });
  const { result, sent } = await send(aws, { method: "POST", path: "/?Action=Scan&Version=2012-08-10", body, host });
  const signer = new SignatureV4({
    credentials: { accessKeyId: AWS_KEY_ID, secretAccessKey: AWS_SECRET },
    region: "us-east-1",
    service: "dynamodb",
    sha256: NodeSha256,
    applyChecksum: true,
  });
  const oracle = await signer.sign(
    {
      method: "POST",
      protocol: "https:",
      hostname: host,
      path: "/",
      query: { Action: "Scan", Version: "2012-08-10" },
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    { signingDate: NOW },
  );
  assert.equal(sent.headers.authorization, oracle.headers.authorization);
  assert.equal(sent.headers["x-amz-date"], oracle.headers["x-amz-date"]);
  assert.equal(sent.headers["x-amz-content-sha256"], oracle.headers["x-amz-content-sha256"]);
  assert.ok(!JSON.stringify(sent.headers).includes(AWS_SECRET), "secret access key never leaves the process");
  assert.match(sent.headers.authorization ?? "", new RegExp(`Credential=${AWS_KEY_ID}/`));
  assert.ok(!result.body.includes(AWS_SECRET));

  await assert.rejects(
    () => send(item("sigv4", { username: AWS_KEY_ID, secret: AWS_SECRET })),
    (err: unknown) => isHttpError(err) && err.status === 400 && /regional AWS host/.test(err.message),
    "a non-AWS host cannot be SigV4 signed",
  );
});

test("client_credentials at a provider token endpoint follows the provider's auth style", async () => {
  const spotify = item("client_credentials", { username: "cid_public", allowedHosts: ["api.spotify.com", "accounts.spotify.com"], kind: "client_secret" });
  const basic = await send(spotify, { method: "POST", path: "/api/token", host: "accounts.spotify.com", body: { grant_type: "client_credentials" } });
  assert.equal(basic.sent.headers.authorization, `Basic ${Buffer.from(`cid_public:${SECRET}`).toString("base64")}`);
  assert.equal(basic.sent.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(basic.sent.body, "grant_type=client_credentials");

  const github = item("client_credentials", { username: "Iv1.appid", allowedHosts: ["api.github.com", "github.com"], kind: "client_secret" });
  const posted = await send(github, { method: "POST", path: "/login/oauth/access_token", host: "github.com", body: { grant_type: "authorization_code", code: "c0de" } });
  assert.equal(posted.sent.headers.authorization, undefined, "post_body providers get no Authorization header");
  const form = new URLSearchParams(posted.sent.body);
  assert.equal(form.get("client_id"), "Iv1.appid");
  assert.equal(form.get("client_secret"), SECRET);
  assert.equal(form.get("code"), "c0de");
  assert.match(posted.result.body, /client_secret=\[redacted\]/, "echoed form body is redacted");

  await assert.rejects(
    () => send(github, { method: "POST", path: "/login/oauth/access_token", host: "github.com", body: { grant_type: "x" }, contentType: "application/json" }),
    (err: unknown) => isHttpError(err) && err.status === 400 && /form-urlencoded/.test(err.message),
  );

  const offEndpoint = await send(spotify, { method: "GET", path: "/v1/search", host: "api.spotify.com" });
  assert.match(offEndpoint.sent.headers.authorization ?? "", /^Basic /, "off the token path client_credentials is Basic, as before");
});

test("refresh items go in the token-endpoint form body with client_id and nowhere else", async () => {
  const refresh = item("refresh", { username: "cid_public", allowedHosts: ["api.spotify.com", "accounts.spotify.com"], name: "SPOTIFY_REFRESH" });
  const ok = await send(refresh, { method: "POST", path: "/api/token", host: "accounts.spotify.com" });
  assert.equal(ok.sent.headers.authorization, undefined, "RFC 6749 section 6 public client: no Basic header");
  const form = new URLSearchParams(ok.sent.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), SECRET);
  assert.equal(form.get("client_id"), "cid_public");
  assert.match(ok.result.body, /refresh_token=\[redacted\]/);

  await assert.rejects(
    () => send(refresh, { method: "GET", path: "/v1/me", host: "api.spotify.com" }),
    (err: unknown) => isHttpError(err) && err.status === 400 && err.extra.status === "inject_denied",
    "a refresh token is never sent to an API host",
  );
});

test("an unknown stored mode is 500 inject_unsupported and the origin is never called", async () => {
  const { seen, fetchImpl } = echo();
  await assert.rejects(
    () =>
      executeConnector(item("weird"), { method: "GET", path: "/v1/x" }, { fetchImpl, resolveAddresses: async () => ["8.8.8.8"] }),
    (err: unknown) => isHttpError(err) && err.status === 500 && err.message === "inject_unsupported" && err.extra.inject === "weird",
  );
  assert.equal(seen.length, 0, "nothing was sent, in particular not Bearer");
  assert.throws(
    () => applyInject({ secret: SECRET, username: null, inject: "Bearer", kind: "secret" }, { host: "h", method: "GET", path: "/", now: NOW }),
    (err: unknown) => isHttpError(err) && err.status === 500,
    "case matters: Bearer is not a mode",
  );
});
