/** Origin bodies are stripped of every encoding of the credential before anything reaches the model (S7). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { executeConnector, redactConnectorBody, type ConnectorItem } from "../src/hosted/connector.ts";
import { redactOauthJson, secretEncodings } from "../src/redact.ts";
import { CANARY } from "./helpers.ts";

const BASIC_SECRET = 'p@ss w"rd/+=2026';
const USER = "svc_user";

function item(secret: string, inject: string, username: string | null = null): ConnectorItem {
  return {
    secret,
    username,
    last4: secret.slice(-4),
    inject,
    allowedHosts: ["api.echo.example"],
    name: "ECHO",
    kind: "secret",
  };
}

/** An origin that reflects what it received: headers, plus the secret in several encodings. */
function echoOrigin(extraBody: (auth: string) => Record<string, unknown>) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? "";
    return new Response(JSON.stringify({ received_authorization: auth, ...extraBody(auth) }), { status: 200 });
  };
}

test("Basic-auth item: neither the secret nor base64(user:secret) survives an echoing origin", async () => {
  const basic = item(BASIC_SECRET, "basic", USER);
  const result = await executeConnector(
    basic,
    { method: "GET", path: "/echo" },
    {
      resolveAddresses: async () => ["8.8.8.8"],
      fetchImpl: echoOrigin(() => ({
        url_form: `https://x.example/?p=${encodeURIComponent(BASIC_SECRET)}`,
        json_escaped_inside: JSON.stringify({ p: BASIC_SECRET }),
        hex: Buffer.from(BASIC_SECRET).toString("hex"),
        b64: Buffer.from(BASIC_SECRET).toString("base64"),
        date: "2026-09-04T10:00:00Z",
      })),
    },
  );
  assert.equal(result.status, 200);
  const b64 = Buffer.from(`${USER}:${BASIC_SECRET}`).toString("base64");
  assert.ok(!result.body.includes(BASIC_SECRET), "raw secret");
  assert.ok(!result.body.includes(b64), "Basic credential");
  assert.ok(!result.body.includes(encodeURIComponent(BASIC_SECRET)), "URL-encoded");
  assert.ok(!result.body.includes(JSON.stringify(BASIC_SECRET).slice(1, -1)), "JSON-escaped");
  assert.ok(!result.body.includes(Buffer.from(BASIC_SECRET).toString("hex")), "hex");
  assert.ok(!result.body.includes(Buffer.from(BASIC_SECRET).toString("base64")), "base64 of secret alone");
  assert.match(result.body, /\[redacted\]/);
  assert.match(result.body, /2026-09-04T10:00:00Z/, "no body-wide last-4 masking of dates");
  assert.match(result.body, /Basic \[redacted\]/);
});

test("Bearer item: token and its encodings are redacted; unrelated 4-char runs are kept", async () => {
  const bearer = item(CANARY, "bearer");
  const result = await executeConnector(
    bearer,
    { method: "GET", path: "/echo" },
    {
      resolveAddresses: async () => ["8.8.8.8"],
      fetchImpl: echoOrigin(() => ({ id: `id_${CANARY.slice(-4)}_kept`, nested: { access_token: "tok_should_go", list: [{ refresh_token: "r1" }] } })),
    },
  );
  assert.ok(!result.body.includes(CANARY));
  assert.ok(!result.body.includes(Buffer.from(`:${CANARY}`).toString("base64")));
  assert.match(result.body, new RegExp(`id_${CANARY.slice(-4)}_kept`), "last-4 is not masked body-wide");
  assert.doesNotMatch(result.body, /tok_should_go/);
  assert.doesNotMatch(result.body, /"r1"/);
});

test("redaction runs before the 256 KiB cut, so a secret straddling the cap never leaks a prefix", async () => {
  const bearer = item(CANARY, "bearer");
  const cap = 256 * 1024;
  const filler = "x".repeat(cap - 10);
  const result = await executeConnector(
    bearer,
    { method: "GET", path: "/big" },
    {
      resolveAddresses: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response(`${filler}${CANARY}${"y".repeat(100)}`, { status: 200 }),
    },
  );
  assert.ok(result.body.length <= cap);
  assert.ok(!result.body.includes(CANARY.slice(0, 12)), "no secret prefix at the cut");
});

test("redactOauthJson walks nested objects and arrays", () => {
  const out = redactOauthJson(
    JSON.stringify({
      data: { token: { access_token: "A", expires_in: 3600 } },
      items: [{ refresh_token: "B" }, { inner: [{ id_token: "C", client_secret: "D" }] }],
      keep: "visible",
    }),
  );
  assert.doesNotMatch(out, /"A"|"B"|"C"|"D"/);
  assert.match(out, /visible/);
  assert.match(out, /"expires_in":3600/);
  assert.equal((out.match(/\[redacted\]/g) ?? []).length, 4);
  assert.match(redactOauthJson('not json but "access_token": "zzz" here'), /"access_token":"\[redacted\]"/);
});

test("secretEncodings includes every form and skips ambiguous short derivations", () => {
  const forms = secretEncodings("abc", "u");
  assert.deepEqual(forms.filter((f) => f === "abc"), ["abc"]);
  assert.ok(!forms.includes("YWJj"), "4-char base64 would mangle unrelated text");
  const long = secretEncodings(CANARY, USER);
  assert.ok(long.includes(Buffer.from(`${USER}:${CANARY}`).toString("base64")));
  assert.ok(long.includes(Buffer.from(CANARY).toString("hex")));
  assert.equal(redactConnectorBody(`x ${CANARY} y`, item(CANARY, "bearer")), "x [redacted] y");
});
