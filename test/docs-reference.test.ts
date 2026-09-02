import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

const SURFACES = [
  "docs/reference/mcp.md",
  "docs/reference/http-api.md",
  "site/src/pages/docs/reference/mcp-tools.astro",
  "site/src/pages/docs/reference/http-api.astro",
] as const;

test("MCP and HTTP reference docs name hosted tools and forbid get_secret", () => {
  for (const rel of SURFACES) {
    const text = read(rel);
    assert.match(text, /http\.request/, rel);
    assert.match(text, /find_items/, rel);
    assert.match(text, /request_grant/, rel);
    assert.match(text, /list_grants/, rel);
    assert.match(text, /get_secret/, rel);
    assert.doesNotMatch(text, /TODO|FIXME|lorem ipsum/i);
  }
  const mcp = read("docs/reference/mcp.md");
  assert.match(mcp, /list_items/);
  assert.match(mcp, /list_secrets/);
  assert.match(mcp, /src\/hosted\/mcp\.ts/);
  const http = read("docs/reference/http-api.md");
  assert.match(http, /\/api\/access/);
  assert.match(http, /\/oauth\/revoke/);
  assert.match(http, /\/runtime\/resolve/);
  assert.match(http, /\/api\/secrets/);
  const publicHttp = read("site/src/pages/docs/reference/http-api.astro");
  assert.match(publicHttp, /X-CSRF-Token/);
  assert.match(publicHttp, /avm_/);
  assert.match(publicHttp, /avt_/);
  assert.match(publicHttp, /response_types_supported/);
  assert.match(publicHttp, /\/mcp.*reflect/i);
  const publicMcp = read("site/src/pages/docs/reference/mcp-tools.astro");
  assert.match(publicMcp, /collect_url/);
  assert.match(publicMcp, /need_item/);
  assert.match(publicMcp, /oauth-protected-resource\/mcp/);
});
