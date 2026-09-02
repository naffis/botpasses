import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { test } from "node:test";
import { bindCors, corsHeaders, corsPublicUrl } from "../src/hosted/http-cors.ts";

function fakeRes(): ServerResponse {
  return new ServerResponse(new IncomingMessage(new Socket()));
}

function fakeReq(origin: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers.origin = origin;
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
