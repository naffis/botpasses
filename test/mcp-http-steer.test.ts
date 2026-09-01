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
  assert.equal(steered.next?.tool, "http.request");
  assert.equal(steered.next?.arguments?.method, "GET");
  assert.equal(steered.next?.arguments?.path, "/v1/me");
  assert.equal(steered.next?.arguments?.host, "api.spotify.com");
  assert.equal(nextForPayload({ status: 200, body: "{}" })?.for_model.includes("redacted"), true);
});

test("pending grant next.arguments merges retry with item_name", () => {
  const next = nextForPayload({
    grant_id: "grt_1",
    status: "pending",
    item_name: "SPOTIFY_TOKEN",
    retry: { method: "GET", path: "/v1/me", host: "api.spotify.com", item_name: "SPOTIFY_TOKEN" },
  });
  assert.equal(next?.tool, "http.request");
  assert.equal(next?.arguments?.item_name, "SPOTIFY_TOKEN");
  assert.equal(next?.arguments?.method, "GET");
  assert.equal(next?.arguments?.path, "/v1/me");
});
