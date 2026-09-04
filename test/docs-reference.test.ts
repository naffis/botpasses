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
  "site/src/content/docs/reference/mcp-tools.md",
  "site/src/content/docs/reference/http-api.md",
] as const;

test("MCP and HTTP reference docs name hosted tools and forbid get_secret", () => {
  for (const rel of SURFACES) {
    const text = read(rel);
    assert.match(text, /http_request/, rel);
    assert.match(text, /find_items/, rel);
    assert.match(text, /request_grant/, rel);
    assert.match(text, /list_grants/, rel);
    assert.match(text, /get_secret/, rel);
    assert.doesNotMatch(text, /TODO|FIXME|lorem ipsum/i);
    assert.doesNotMatch(text, /this origin/i, `${rel} says botpasses.com, not "this origin"`);
  }
  const mcp = read("docs/reference/mcp.md");
  assert.match(mcp, /list_items/);
  assert.match(mcp, /list_secrets/);
  assert.match(mcp, /src\/hosted\/mcp\.ts/);
  assert.match(mcp, /task_id/, "request_grant returns task_id");
  assert.match(mcp, /http\.request.*alias|alias.*http\.request/, "old name documented as an alias once");
  const http = read("docs/reference/http-api.md");
  assert.match(http, /\/api\/access/);
  assert.match(http, /\/oauth\/revoke/);
  assert.match(http, /\/runtime\/resolve/);
  assert.match(http, /\/api\/secrets/);
  assert.match(http, /\/api\/folders/);
  assert.match(http, /\/api\/orgs/);
  assert.match(http, /GET.*\/mcp.*SSE|SSE.*GET.*\/mcp/);
  const publicHttp = read("site/src/content/docs/reference/http-api.md");
  assert.match(publicHttp, /X-CSRF-Token/);
  assert.match(publicHttp, /avm_/);
  assert.match(publicHttp, /avt_/);
  assert.match(publicHttp, /response_types_supported/);
  assert.match(publicHttp, /\/mcp.*reflect/i);
  assert.match(publicHttp, /POST \| `\/api\/items\/:id`/);
  assert.match(publicHttp, /`\/api\/folders`/);
  assert.match(publicHttp, /`\/api\/orgs`/);
  assert.match(publicHttp, /`\/approve\?token=/);
  assert.match(publicHttp, /spotify\/callback/);
  const publicMcp = read("site/src/content/docs/reference/mcp-tools.md");
  assert.match(publicMcp, /collect_url/);
  assert.match(publicMcp, /need_item/);
  assert.match(publicMcp, /oauth-protected-resource\/mcp/);
  assert.match(publicMcp, /`kind`, `last4`, `allowed_hosts`, `inject`, `environment`/, "find_items found fields");
  assert.match(publicMcp, /Instructions the server sends to the model/);
  assert.doesNotMatch(publicMcp, /^\| `environment` \|/m, "no environment argument row in any tool table");
  assert.match(publicMcp, /there is no environment argument/);
});
