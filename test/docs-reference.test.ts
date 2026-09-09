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
  assert.match(publicHttp, /integrations\/:provider\/callback/);
  assert.match(publicHttp, /integrations\/spotify\/callback/);
  assert.match(mcp, /user_connect_required/, "the pre-dial refusal for a user-only path is documented");
  assert.match(mcp, /connect_url/);
  assert.match(http, /need-items\/:id\/deny/);
  assert.match(http, /need_id/, "the connect start body takes the inbox need id");
  const publicMcp = read("site/src/content/docs/reference/mcp-tools.md");
  assert.match(publicMcp, /collect_url/);
  assert.match(publicMcp, /need_item/);
  assert.match(publicMcp, /user_connect_required/);
  assert.match(publicMcp, /oauth-protected-resource\/mcp/);
  assert.match(publicMcp, /`kind`, `last4`, `allowed_hosts`, `inject`, `environment`/, "find_items found fields");
  assert.match(publicMcp, /Instructions the server sends to the model/);
  assert.doesNotMatch(publicMcp, /^\| `environment` \|/m, "no environment argument row in any tool table");
  assert.match(publicMcp, /there is no environment argument/);
});

test("site docs, the HTTP reference, and the README describe the local CLI and server as they are", () => {
  // The local stdio server has the same five tools as hosted, including http_request.
  for (const rel of ["site/src/content/docs/install.md", "site/src/content/docs/connect/cursor.md", "site/src/content/docs/connect/claude-code.md"]) {
    const text = read(rel);
    assert.doesNotMatch(text, /`list_secrets`, `request_grant`, and `list_grants`/, `${rel} lists the old local tool names`);
    assert.doesNotMatch(text, /no `http_request`/, `${rel} says the local server has no http_request`);
    assert.match(text, /`http_request`/, rel);
  }
  // vault serve serves /api/items next to /api/secrets.
  for (const rel of ["docs/reference/http-api.md", "site/src/content/docs/reference/http-api.md"]) {
    const text = read(rel);
    const local = text.slice(text.search(/^## Local/m));
    assert.ok(local.length > 0, `${rel} has a local section`);
    assert.match(local, /`\/api\/items`/, `${rel} lists /api/items on the local plane`);
    assert.doesNotMatch(local, /no `\/api\/items`/i, `${rel} denies /api/items on the local plane`);
  }
  // --ttl belongs to --session; the scope flags exclude each other; per-command help exists.
  const cli = read("site/src/content/docs/reference/cli.md");
  assert.match(cli, /\[--once \\\| --session \[--ttl 8h\]\]/);
  assert.match(cli, /`--ttl` applies to `--session` only/);
  assert.match(cli, /--user-jwt=TOKEN/);
  assert.match(cli, /`vault <command> --help`/);
  const readme = read("README.md");
  assert.doesNotMatch(readme, /^\| `list_secrets` \|/m, "README local tool table names the current tools");
  assert.match(readme, /^\| `http_request` \|/m);
  assert.match(readme, /\[--once\\\|--session \[--ttl 8h\]\]/);
});

test("SECURITY.md names the disclosure mailbox", () => {
  const security = read("SECURITY.md");
  assert.match(security, /security@botpasses\.com/);
  assert.match(security, /Do not open a public GitHub issue/);
  assert.match(read("README.md"), /SECURITY\.md/);
});
