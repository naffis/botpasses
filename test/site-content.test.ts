import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const dist = join(process.cwd(), "site/dist");

function page(name: string): string {
  return readFileSync(join(dist, name), "utf8");
}

test("site dist has homepage, design, privacy, and docs", () => {
  assert.ok(existsSync(join(dist, "index.html")));
  assert.ok(existsSync(join(dist, "design.html")));
  assert.ok(existsSync(join(dist, "docs.html")));
  assert.ok(existsSync(join(dist, "docs/start.html")));
  assert.ok(existsSync(join(dist, "docs/how-to/revoke-access.html")));
  assert.ok(existsSync(join(dist, "docs/connect/grok.html")));
  const home = page("index.html");
  assert.match(home, /Named credentials for agents\. The model never sees the value\./);
  assert.match(home, /Create account/);
  assert.doesNotMatch(home, /Operator token/);
  const privacy = page("privacy.html");
  assert.match(privacy, /Fly/);
  assert.match(privacy, /Neon/);
  assert.match(privacy, /Cloudflare/);
  assert.match(privacy, /Resend/);
  assert.match(privacy, /Sentry/);
  assert.doesNotMatch(privacy, /Clerk/);
  const design = page("design.html");
  assert.match(design, /#0B0F0C/);
  assert.match(design, /#7DDA88/);
  const grok = page("docs/connect/grok.html");
  assert.doesNotMatch(grok, /paste a Clerk JWT/i);
  assert.match(grok, /data-testid="docs-search"/);
  const revoke = page("docs/how-to/revoke-access.html");
  assert.match(revoke, /Access panel/);
  const mcp = page("docs/reference/mcp-tools.html");
  assert.match(mcp, /http\.request/);
  assert.match(mcp, /find_items/);
  assert.match(mcp, /get_secret/);
  assert.match(mcp, /collect_url/);
  const httpApi = page("docs/reference/http-api.html");
  assert.match(httpApi, /\/api\/access/);
  assert.match(httpApi, /\/oauth\/revoke/);
  assert.match(httpApi, /\/runtime\/resolve/);
  assert.match(httpApi, /X-CSRF-Token/);
  const index = page("docs.html");
  assert.match(index, /MCP tools/);
  assert.match(index, /HTTP API/);
});
