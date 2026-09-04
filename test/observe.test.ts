import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSentryEnvelope,
  captureException,
  logAuthEvent,
  logRequest,
  logVaultEvent,
  packageVersion,
  redactMessage,
  requestIdFrom,
  sentryTarget,
} from "../src/hosted/observe.ts";

function captureStderr(run: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("packageVersion reads package.json", () => {
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
});

test("logVaultEvent drops credential-shaped fields", () => {
  const [line] = captureStderr(() =>
    logVaultEvent("x", { value: "s", password: "p", code: "1", token: "t", secret: "z", authorization: "B", cookie: "c", ok: 1 }),
  );
  assert.deepEqual(Object.keys(line ?? {}).sort(), ["at", "event", "ok"]);
});

test("logRequest writes method, path without query, status, ms, request_id", () => {
  const [line] = captureStderr(() =>
    logRequest({ method: "POST", path: "/api/auth/otp/verify?code=123456", status: 200, ms: 12.7, requestId: "req-1", principal: "anon" }),
  );
  assert.equal(line?.event, "request");
  assert.equal(line?.method, "POST");
  assert.equal(line?.path, "/api/auth/otp/verify");
  assert.equal(line?.status, 200);
  assert.equal(line?.ms, 13);
  assert.equal(line?.request_id, "req-1");
  assert.equal(line?.principal, "anon");
  assert.ok(!JSON.stringify(line).includes("123456"));
});

test("requestIdFrom reuses a well-formed inbound id and mints otherwise", () => {
  assert.equal(requestIdFrom({ "x-request-id": "fly-abc.123:z" }), "fly-abc.123:z");
  assert.equal(requestIdFrom({ "x-request-id": ["first", "second"] }), "first");
  assert.match(requestIdFrom({}), /^[0-9a-f-]{36}$/);
  assert.match(requestIdFrom({ "x-request-id": "bad id with spaces" }), /^[0-9a-f-]{36}$/);
  assert.match(requestIdFrom({ "x-request-id": "x".repeat(200) }), /^[0-9a-f-]{36}$/);
});

test("logAuthEvent hashes the email and never logs the code", () => {
  const [line] = captureStderr(() => logAuthEvent("otp_failed", { email: "Person@Example.com", code: "123456", attempts: 3 }));
  assert.equal(line?.event, "auth_otp_failed");
  assert.equal(line?.attempts, 3);
  assert.match(String(line?.email_hash), /^[0-9a-f]{12}$/);
  assert.ok(!("email" in (line ?? {})));
  assert.ok(!("code" in (line ?? {})));
  const [same] = captureStderr(() => logAuthEvent("otp_failed", { email: "  person@example.com " }));
  assert.equal(same?.email_hash, line?.email_hash, "case and whitespace insensitive");
});

test("redactMessage strips machine tokens, bearer values, and pg key details", () => {
  const out = redactMessage(
    'client avm_abcDEF123-_ rejected; header "Bearer eyJhbGciOi.xyz" ; duplicate key value violates unique constraint "users_email" DETAIL: Key (email)=(a@b.c) already exists.',
  );
  assert.ok(!out.includes("avm_abcDEF123"));
  assert.ok(out.includes("avm_[redacted]"));
  assert.ok(!out.includes("eyJhbGciOi"));
  assert.ok(out.includes("Bearer [redacted]"));
  assert.ok(!out.includes("a@b.c"));
  assert.ok(out.includes("Key ([redacted])"));
  assert.equal(redactMessage("x".repeat(900)).length, 500);
});

test("sentryTarget derives the envelope URL and auth header from the DSN", () => {
  const t = sentryTarget("https://publickey@o123.ingest.sentry.io/456");
  assert.ok(t);
  assert.equal(t.url, "https://o123.ingest.sentry.io/api/456/envelope/");
  assert.equal(t.project, "456");
  assert.match(t.authHeader, /^Sentry sentry_version=7, sentry_client=botpasses\/\d+\.\d+\.\d+, sentry_key=publickey$/);
  assert.equal(sentryTarget("not a url"), undefined);
  assert.equal(sentryTarget("https://o123.ingest.sentry.io/456"), undefined, "no key");
});

test("buildSentryEnvelope is three JSON lines with release, environment, and event_id", () => {
  const body = buildSentryEnvelope("https://k@h.io/1", {
    message: "boom",
    errorName: "TypeError",
    environment: "staging",
    release: "botpasses@0.5.0",
    eventId: "a".repeat(32),
    sentAt: "2026-09-04T00:00:00.000Z",
    context: { requestId: "r1", path: "/mcp" },
  });
  const lines = body.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { event_id: "a".repeat(32), sent_at: "2026-09-04T00:00:00.000Z", dsn: "https://k@h.io/1" });
  assert.deepEqual(lines[1], { type: "event" });
  const event = lines[2] ?? {};
  assert.equal(event.release, "botpasses@0.5.0");
  assert.equal(event.environment, "staging");
  assert.equal(event.event_id, "a".repeat(32));
  assert.equal(event.level, "error");
  assert.deepEqual(event.message, { formatted: "boom" });
  assert.deepEqual(event.tags, { request_id: "r1", path: "/mcp" });
});

test("captureException posts a redacted envelope with X-Sentry-Auth and a timeout signal", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 200 });
  };
  const lines = captureStderr(() => undefined);
  assert.equal(lines.length, 0);
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    await captureException(
      new Error("token avm_secret123 leaked"),
      { requestId: "r9", path: "/mcp" },
      { SENTRY_DSN: "https://pk@o1.ingest.sentry.io/77", VAULT_DEPLOY_PLANE: "production" },
      fetchFn,
    );
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://o1.ingest.sentry.io/api/77/envelope/");
  const headers = call.init.headers as Record<string, string>;
  assert.match(headers["x-sentry-auth"] ?? "", /sentry_key=pk/);
  assert.equal(headers["content-type"], "application/x-sentry-envelope");
  assert.ok(call.init.signal instanceof AbortSignal);
  const body = String(call.init.body);
  assert.ok(!body.includes("avm_secret123"));
  assert.ok(body.includes('"environment":"production"'));
  assert.ok(body.includes(`"release":"botpasses@${packageVersion()}"`));
  assert.ok(logged.some((l) => l.includes('"event":"exception"')));
  assert.ok(!logged.join("\n").includes("avm_secret123"));
});

test("captureException without a DSN logs only, and a failing fetch never throws", async () => {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    let fetched = 0;
    await captureException(new Error("x"), {}, {}, async () => {
      fetched += 1;
      return new Response(null, { status: 200 });
    });
    assert.equal(fetched, 0);
    await captureException(new Error("y"), {}, { SENTRY_DSN: "https://k@h.io/1" }, async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((l) => l.includes('"event":"sentry_send_failed"') && l.includes('"reason":"TimeoutError"')));
});
