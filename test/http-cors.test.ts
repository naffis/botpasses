import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { test } from "node:test";
import {
  bindCors,
  corsHeaders,
  corsPublicUrl,
  originOk,
  publicSiteAllowsForeignOrigin,
} from "../src/hosted/http-cors.ts";

function fakeRes(): ServerResponse {
  return new ServerResponse(new IncomingMessage(new Socket()));
}

function fakeReq(origin: string, extras: { host?: string; method?: string } = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers.origin = origin;
  if (extras.host) req.headers.host = extras.host;
  if (extras.method) req.method = extras.method;
  return req;
}

test("CORS Origin and publicUrl stay on the response that bound them", () => {
  const grok = fakeRes();
  const claude = fakeRes();
  bindCors(grok, {
    req: fakeReq("https://grok.x.ai"),
    path: "/mcp",
    allowed: ["staging.botpasses.com"],
    testMode: false,
    publicUrl: "https://staging.botpasses.com",
  });
  bindCors(claude, {
    req: fakeReq("https://claude.ai"),
    path: "/mcp",
    allowed: ["botpasses.com"],
    testMode: false,
    publicUrl: "https://botpasses.com",
  });
  assert.equal(corsHeaders(grok)["access-control-allow-origin"], "https://grok.x.ai");
  assert.equal(corsHeaders(claude)["access-control-allow-origin"], "https://claude.ai");
  assert.equal(corsPublicUrl(grok), "https://staging.botpasses.com");
  assert.equal(corsPublicUrl(claude), "https://botpasses.com");
});

test("operator /api does not reflect a foreign Origin", () => {
  const res = fakeRes();
  bindCors(res, {
    req: fakeReq("https://evil.example"),
    path: "/api/items",
    allowed: ["staging.botpasses.com"],
    testMode: false,
    publicUrl: "https://staging.botpasses.com",
  });
  assert.equal(corsHeaders(res)["access-control-allow-origin"], undefined);
});

test("public site safe methods accept a foreign Origin; privileged and mutating do not", () => {
  assert.equal(publicSiteAllowsForeignOrigin("/og.png", "GET"), true);
  assert.equal(publicSiteAllowsForeignOrigin("/favicon.ico", "HEAD"), true);
  assert.equal(publicSiteAllowsForeignOrigin("/logo.png", "OPTIONS"), true);
  assert.equal(publicSiteAllowsForeignOrigin("/og.png", "POST"), false);
  assert.equal(publicSiteAllowsForeignOrigin("/api/items", "GET"), false);
  assert.equal(publicSiteAllowsForeignOrigin("/console", "GET"), false);
  assert.equal(publicSiteAllowsForeignOrigin("/sign-in", "GET"), false);
  const allowed = ["staging.botpasses.com"];
  const card = fakeReq("https://composer.example", {
    host: "staging.botpasses.com",
    method: "GET",
  });
  assert.equal(originOk(card, allowed, "/og.png"), true);
  const api = fakeReq("https://evil.example", { host: "staging.botpasses.com", method: "GET" });
  assert.equal(originOk(api, allowed, "/api/items"), false);
  const wrongHost = fakeReq("https://composer.example", { host: "evil.example.com", method: "GET" });
  assert.equal(originOk(wrongHost, allowed, "/og.png"), false);
  const res = fakeRes();
  bindCors(res, {
    req: fakeReq("https://composer.example", { method: "GET" }),
    path: "/og.png",
    allowed: ["staging.botpasses.com"],
    testMode: false,
    publicUrl: "https://staging.botpasses.com",
  });
  assert.equal(corsHeaders(res)["access-control-allow-origin"], "https://composer.example");
});
