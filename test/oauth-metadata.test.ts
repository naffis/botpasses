import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizationServerMetadata,
  isMcpClientSurface,
  isOauthDiscoveryPath,
  mcpWwwAuthenticate,
  oauthDiscoveryDocument,
  protectedResourceMetadata,
} from "../src/hosted/oauth-metadata.ts";

const ORIGIN = "https://staging.botpasses.com";

test("AS metadata has RFC 8414 required fields and S256 only", () => {
  const doc = authorizationServerMetadata(ORIGIN);
  assert.equal(doc.issuer, ORIGIN);
  assert.deepEqual(doc.response_types_supported, ["code"]);
  assert.deepEqual(doc.code_challenge_methods_supported, ["S256"]);
  assert.ok(doc.grant_types_supported.includes("authorization_code"));
  assert.ok(doc.token_endpoint_auth_methods_supported.includes("none"));
  assert.match(doc.authorization_endpoint, /\/oauth\/authorize$/);
  assert.match(doc.revocation_endpoint, /\/oauth\/revoke$/);
  assert.doesNotMatch(JSON.stringify(doc), /clerk\./);
});

test("PRM names MCP resource and header bearer", () => {
  const doc = protectedResourceMetadata(`${ORIGIN}/`);
  assert.equal(doc.resource, `${ORIGIN}/mcp`);
  assert.deepEqual(doc.authorization_servers, [ORIGIN]);
  assert.deepEqual(doc.bearer_methods_supported, ["header"]);
});

test("WWW-Authenticate resource_metadata is an absolute path-aware URL", () => {
  const header = mcpWwwAuthenticate(ORIGIN, "botpasses");
  assert.match(
    header,
    /^Bearer realm="botpasses", resource_metadata="https:\/\/staging\.botpasses\.com\/\.well-known\/oauth-protected-resource\/mcp"$/,
  );
  assert.doesNotMatch(header, /resource_metadata="\/\.well-known/);
});

test("discovery URLs serve the same documents (root, /mcp suffix, path insert)", () => {
  const as = authorizationServerMetadata(ORIGIN);
  const prm = protectedResourceMetadata(ORIGIN);
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/mcp/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
  ]) {
    assert.deepEqual(oauthDiscoveryDocument(path, ORIGIN), as, path);
  }
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/mcp/.well-known/oauth-protected-resource",
  ]) {
    assert.deepEqual(oauthDiscoveryDocument(path, ORIGIN), prm, path);
  }
  assert.equal(oauthDiscoveryDocument("/console", ORIGIN), undefined);
});

test("MCP client surfaces include discovery, /mcp, and /oauth", () => {
  assert.equal(isOauthDiscoveryPath("/.well-known/oauth-authorization-server"), true);
  assert.equal(isMcpClientSurface("/mcp"), true);
  assert.equal(isMcpClientSurface("/mcp/tools"), true);
  assert.equal(isMcpClientSurface("/oauth/register"), true);
  assert.equal(isMcpClientSurface("/api/items"), false);
  assert.equal(isMcpClientSurface("/console"), false);
});
