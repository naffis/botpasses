import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorTargetFromArgs } from "../src/hosted/mcp-http.ts";
import { attachMcpNext, nextForPayload } from "../src/hosted/mcp-steer.ts";

test("connectorTargetFromArgs splits a full https path URL", () => {
  const t = connectorTargetFromArgs({
    method: "GET",
    path: "https://api.spotify.com/v1/me",
  });
  assert.equal(t.host, "api.spotify.com");
  assert.equal(t.path, "/v1/me");
  assert.equal(t.method, "GET");
  assert.equal(t.timeoutMs, 10_000, "default origin deadline");
  assert.equal(t.dryRun, false);
});

test("connectorTargetFromArgs keeps path and host when already split", () => {
  const t = connectorTargetFromArgs({
    host: "api.spotify.com",
    method: "GET",
    path: "/v1/me",
  });
  assert.equal(t.host, "api.spotify.com");
  assert.equal(t.path, "/v1/me");
});

test("connectorTargetFromArgs rejects missing host and item_name", () => {
  assert.throws(
    () => connectorTargetFromArgs({ method: "GET", path: "/v1/me" }),
    /item_name or host/,
  );
});

test("timeout_ms is clamped to 1000..30000 and dry_run must be a boolean (3.4)", () => {
  const base = { host: "api.example.com", method: "GET", path: "/v1/me" };
  assert.equal(connectorTargetFromArgs({ ...base, timeout_ms: 50 }).timeoutMs, 1000);
  assert.equal(connectorTargetFromArgs({ ...base, timeout_ms: 99_999 }).timeoutMs, 30_000);
  assert.equal(connectorTargetFromArgs({ ...base, timeout_ms: 2500.4 }).timeoutMs, 2500);
  assert.throws(() => connectorTargetFromArgs({ ...base, timeout_ms: "fast" }), /timeout_ms must be a number/);
  assert.equal(connectorTargetFromArgs({ ...base, dry_run: true }).dryRun, true);
  assert.throws(() => connectorTargetFromArgs({ ...base, dry_run: "yes" }), /dry_run must be true or false/);
});

test("need_item payload includes next.for_model", () => {
  const steered = attachMcpNext({
    status: "need_item",
    collect_url: "https://staging.botpasses.com/collect/nid_x",
    suggested_name: "SPOTIFY_TOKEN",
    host: "api.spotify.com",
    client_name: "grok",
    need_id: "nid_x",
    message: "Open this Botpasses URL",
    retry: { method: "GET", path: "/v1/me", host: "api.spotify.com" },
  }) as { next?: { for_model?: string; tool?: string; arguments?: Record<string, string> } };
  assert.match(steered.next?.for_model ?? "", /collect_url/);
  assert.equal(steered.next?.tool, "http_request");
  assert.equal(steered.next?.arguments?.method, "GET");
  assert.equal(steered.next?.arguments?.path, "/v1/me");
  assert.equal(steered.next?.arguments?.host, "api.spotify.com");
  assert.equal(nextForPayload({ origin_status: 200, status: 200, body: "{}" })?.for_model.includes("redacted"), true);
});

test("origin results are keyed on origin_status, so a numeric legacy status alone is not steered", () => {
  assert.equal(nextForPayload({ status: 200, body: "{}" }), undefined);
  assert.match(nextForPayload({ origin_status: 200, body: "{}" })?.for_model ?? "", /origin_headers/);
});

test("origin 401 next tells the model to retry and that a one-call approval was spent", () => {
  const next = nextForPayload({
    origin_status: 401,
    status: 401,
    body: "",
    hint: "Upstream 401",
    retry: { method: "GET", path: "/v1/me", host: "api.spotify.com", item_name: "SPOTIFY_SECRET" },
  });
  assert.equal(next?.tool, "http_request");
  assert.match(next?.for_model ?? "", /one-call approval was spent/);
  assert.doesNotMatch(next?.for_model ?? "", /same .*approval is still valid/i, "no promise that a prompt grant survives an origin answer");
  assert.equal(next?.arguments?.item_name, "SPOTIFY_SECRET");
});

test("origin 4xx says fix the request, 5xx says retry once; neither asks for a new approval (3.4)", () => {
  const bad = nextForPayload({ origin_status: 404, status: 404, body: "{}", retry: { method: "GET", path: "/v1/nope", host: "api.example.com" } });
  assert.equal(bad?.tool, "http_request");
  assert.match(bad?.for_model ?? "", /rejected by the API; change the path, query, or body before retrying/);
  assert.match(bad?.for_model ?? "", /Do not ask for a new approval/);
  const flaky = nextForPayload({ origin_status: 503, status: 503, body: "", retry: { method: "GET", path: "/v1/me", host: "api.example.com" } });
  assert.equal(flaky?.tool, "http_request");
  assert.match(flaky?.for_model ?? "", /Transient origin error; retry once/);
  for (const next of [bad, flaky, nextForPayload({ origin_status: 401, body: "" }), nextForPayload({ status: "need_item", collect_url: "x" })]) {
    assert.doesNotMatch(next?.for_model ?? "", /spotify|grok/i, "generic steering names no vendor");
    assert.doesNotMatch(next?.for_model ?? "", /http\.request|—/);
  }
});

test("body_too_large is not a transient 5xx: the model is told to narrow the call, not to retry it (R3-8)", () => {
  const retry = { method: "GET", path: "/v1/items", host: "api.example.com", item_name: "X" };
  const body = JSON.stringify({ error: "body_too_large", hint: "The origin response exceeded 1048576 bytes and was discarded." });
  const cut = nextForPayload({ origin_status: 502, status: 502, body, origin_headers: {}, retry });
  assert.equal(cut?.tool, "http_request");
  assert.match(cut?.for_model ?? "", /larger than 1 MiB/);
  assert.match(cut?.for_model ?? "", /Do not retry the same call/);
  assert.match(cut?.for_model ?? "", /pagination|page size|fields/);
  assert.doesNotMatch(cut?.for_model ?? "", /retry once|Transient/i);
  assert.equal(cut?.arguments?.item_name, "X", "the narrowed retry keeps the item and target");
  // A 502 whose body is the origin's own (JSON with another error, or not JSON) still reads as transient.
  const origin502 = nextForPayload({ origin_status: 502, status: 502, body: JSON.stringify({ error: "upstream_timeout" }), retry });
  assert.match(origin502?.for_model ?? "", /Transient origin error; retry once/);
  const html502 = nextForPayload({ origin_status: 502, status: 502, body: "<html>Bad Gateway</html>", retry });
  assert.match(html502?.for_model ?? "", /retry once/);
});

test("dry_run reports steer to a real call or to fixing the target, and never to pasting a key", () => {
  const go = nextForPayload({ dry_run: true, would_send: true, reason: "ok", retry: { method: "GET", path: "/v1/me", item_name: "X" } });
  assert.match(go?.for_model ?? "", /nothing was sent/i);
  assert.match(go?.for_model ?? "", /without dry_run/);
  assert.equal(go?.arguments?.item_name, "X");
  const no = nextForPayload({ dry_run: true, would_send: false, reason: "grant_required" });
  assert.match(no?.for_model ?? "", /reason: grant_required/);
  assert.doesNotMatch(no?.for_model ?? "", /paste/i);
});

test("INF-49: user_connect_required steers the model to hand over connect_url, wait for the operator, then retry once", () => {
  const next = nextForPayload({
    status: "user_connect_required",
    provider: "spotify",
    item_name: "SPOTIFY_SECRET",
    refresh_item_name: "SPOTIFY_REFRESH",
    connect_url: "https://botpasses.com/console#credentials/item/itm_1?connect=spotify&agent=cli_1&need=nid_1",
    need_id: "nid_1",
    hint: "x",
    retry: { method: "GET", path: "/v1/me", host: "api.spotify.com", item_name: "SPOTIFY_SECRET" },
  });
  assert.ok(next);
  assert.equal(next.tool, "http_request");
  assert.match(next.for_model, /connect_url/);
  assert.match(next.for_model, /Do not retry until/);
  assert.match(next.for_model, /once/);
  assert.doesNotMatch(next.for_model, /paste/);
  assert.deepEqual(next.arguments, { method: "GET", path: "/v1/me", host: "api.spotify.com", item_name: "SPOTIFY_SECRET" });
});

test("pending grant next.arguments merges retry with item_name", () => {
  const next = nextForPayload({
    grant_id: "grt_1",
    status: "pending",
    item_name: "SPOTIFY_TOKEN",
    retry: { method: "GET", path: "/v1/me", host: "api.spotify.com", item_name: "SPOTIFY_TOKEN" },
  });
  assert.equal(next?.tool, "http_request");
  assert.equal(next?.arguments?.item_name, "SPOTIFY_TOKEN");
  assert.equal(next?.arguments?.method, "GET");
  assert.equal(next?.arguments?.path, "/v1/me");
});
