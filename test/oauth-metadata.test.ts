import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizationServerMetadata,
  isMcpClientSurface,
  isOauthDiscoveryPath,
  mcpWwwAuthenticate,
  oauthDiscoveryDocument,
  wwwAuthenticateFor401,
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

test("openid-configuration carries the OIDC Discovery required fields and advertises CIMD", () => {
  const doc = authorizationServerMetadata(ORIGIN);
  assert.deepEqual(doc.subject_types_supported, ["public"]);
  assert.deepEqual(doc.id_token_signing_alg_values_supported, ["RS256"]);
  assert.equal(doc.authorization_response_iss_parameter_supported, true);
  assert.equal(doc.client_id_metadata_document_supported, true);
  assert.deepEqual(oauthDiscoveryDocument("/.well-known/openid-configuration", ORIGIN), doc);
});

test("PRM names MCP resource and header bearer", () => {
  const doc = protectedResourceMetadata(`${ORIGIN}/`);
  assert.equal(doc.resource, `${ORIGIN}/mcp`);
  assert.deepEqual(doc.authorization_servers, [ORIGIN]);
  assert.deepEqual(doc.bearer_methods_supported, ["header"]);
});

test("GET /mcp 401 does not advertise OAuth; POST /mcp 401 still does", () => {
  const realm = "botpasses";
  assert.equal(wwwAuthenticateFor401("GET", "/mcp", ORIGIN, realm), undefined);
  assert.equal(wwwAuthenticateFor401("HEAD", "/mcp", ORIGIN, realm), undefined);
  assert.equal(wwwAuthenticateFor401("get", "/mcp/tools", ORIGIN, realm), undefined);
  const post = wwwAuthenticateFor401("POST", "/mcp", ORIGIN, realm);
  assert.ok(post);
  assert.match(post, /resource_metadata="https:\/\/staging\.botpasses\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
  const api = wwwAuthenticateFor401("GET", "/api/items", ORIGIN, realm);
  assert.equal(api, `Bearer realm="${realm}"`);
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
