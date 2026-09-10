import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const dist = join(process.cwd(), "site/dist");

function page(name: string): string {
  return readFileSync(join(dist, name), "utf8");
}

/** Visible text of a page: tags stripped (Shiki splits code into spans) and entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The R-06 slug list plus every page added since. All must exist as built HTML. */
const REQUIRED_PAGES = [
  "index.html",
  "design.html",
  "security.html",
  "privacy.html",
  "terms.html",
  "changelog.html",
  "404.html",
  "docs.html",
  "docs/start.html",
  "docs/install.html",
  "docs/how-to/store-a-secret.html",
  "docs/how-to/guided-setup.html",
  "docs/how-to/grant-access.html",
  "docs/how-to/revoke-access.html",
  "docs/how-to/use-an-oauth-client-secret.html",
  "docs/how-to/connect-cursor.html",
  "docs/how-to/connect-claude-code.html",
  "docs/connect/grok.html",
  "docs/connect/claude.html",
  "docs/connect/claude-code.html",
  "docs/connect/cursor.html",
  "docs/connect/chatgpt.html",
  "docs/connect/openai.html",
  "docs/reference/mcp-tools.html",
  "docs/reference/cli.html",
  "docs/reference/http-api.html",
  "docs/reference/rate-limits.html",
  "docs/explanation/why-the-model-never-sees-the-value.html",
  "docs/troubleshooting.html",
  "docs/faq.html",
  "docs/self-hosting.html",
  "docs/security/disclosure.html",
];

test("site dist has every documented URL", () => {
  for (const rel of REQUIRED_PAGES) assert.ok(existsSync(join(dist, rel)), rel);
});

test("homepage sells the product and links the right places", () => {
  const home = page("index.html");
  assert.match(home, /<h1>\s*Your agent can call[\s\S]*Stripe[\s\S]*The model does not get the key\.\s*<\/h1>/);
  assert.match(home, /data-hero-rotate="/);
  assert.match(home, /class="hero-rotate-word">Stripe<\/span>/);
  assert.doesNotMatch(home, /hero-rotate-sizer/);
  assert.match(home, /class="hero-rotate-word">Stripe<\/span><\/span>\. The model does not get the key\./);
  for (const service of ["Slack", "GitHub", "Salesforce", "Twilio", "Shopify", "Notion"]) {
    assert.match(home, new RegExp(`data-hero-rotate="[^"]*${service}`), service);
  }
  assert.match(home, /<script type="module" src="\/_astro\/[^"]+\.js"/);
  assert.match(home, /Create account/);
  assert.doesNotMatch(home, /Operator token/);
  assert.match(home, /How it works/);
  assert.match(text(home), /"name": "http_request"/);
  assert.match(home, /approval_code/);
  assert.match(home, /What the model sees/);
  assert.match(home, /What the API sees/);
  for (const w of ["Claude", "Claude Code", "Cursor", "ChatGPT", "Grok", "Any MCP client"]) {
    assert.match(home, new RegExp(`<li>${w}</li>`), w);
  }
  assert.match(home, /grant-vault, not zero-knowledge/);
  assert.match(home, /Who can decrypt/);
  assert.match(home, /Who cannot/);
  assert.match(home, /github\.com\/naffis\/botpasses/);
  assert.match(home, /Free while in beta/);
  assert.match(home, /Botpasses is a grant-vault for AI agents/);
  assert.match(home, /The model does not get the key/);
  assert.doesNotMatch(home, /The model never sees the value/);
  assert.doesNotMatch(home, /The model never receives the value/);
  assert.match(home, /What is Botpasses\?/);
  assert.match(home, /Is this a password manager\?/);
  assert.match(home, /Composio/);
  assert.match(home, /"@type":"FAQPage"/);
  assert.match(home, /prompt-injected/);
  assert.match(home, /mailto:support@botpasses\.com/);
  assert.match(home, /mailto:security@botpasses\.com/);
  assert.match(home, /class="wrap wide"/);
});

test("primary nav drops Home and Design; footer carries Design, GitHub, support, disclosure", () => {
  const home = page("index.html");
  const nav = /<nav class="primary"[^>]*>([\s\S]*?)<\/nav>/.exec(home)?.[1] ?? "";
  assert.doesNotMatch(nav, />Home</);
  assert.doesNotMatch(nav, /href="\/design"/);
  assert.match(nav, /href="https:\/\/github\.com\/naffis\/botpasses"/);
  assert.match(nav, /href="\/docs"/);
  assert.match(nav, /href="\/security"/);
  assert.match(nav, /href="\/sign-in"/);
  const footer = /<footer[\s\S]*?<\/footer>/.exec(home)?.[0] ?? "";
  assert.match(footer, /href="\/design"/);
  assert.match(footer, /href="\/changelog"/);
  assert.match(footer, /github\.com\/naffis\/botpasses/);
  assert.match(footer, /mailto:support@botpasses\.com/);
  assert.match(footer, /href="\/docs\/security\/disclosure"/);
});

test("security page carries the trust model, encryption, connector, tests, and disclosure", () => {
  const sec = page("security.html");
  assert.match(sec, /id="trust-model"/);
  assert.match(sec, /not zero-knowledge/);
  assert.match(sec, /<table aria-label="Which surfaces see a secret value">/);
  assert.match(sec, /Model context \/ chat transcript/);
  assert.match(sec, /AES-256-GCM/);
  assert.match(sec, /orgId\|itemId\|allowed_hosts_json\|inject/);
  assert.match(sec, /email-at-rest/);
  assert.match(sec, /OAuth-token-at-rest/);
  assert.doesNotMatch(sec, /organisation id as additional authenticated data/);
  assert.match(sec, /KMS/);
  assert.match(sec, /Exact host allowlist/);
  assert.match(sec, /No redirects/);
  assert.match(sec, /id="tests"/);
  assert.match(sec, /canary/);
  assert.match(sec, /security@botpasses\.com/);
  assert.match(sec, /\.well-known\/security\.txt/);
  assert.match(sec, /adr\/0006-grant-vault-trust-model\.md/);
  assert.doesNotMatch(sec, /injected into tool or runtime env only/);
  assert.match(sec, /attaches the value to an outbound API call/);
});

test("docs pages keep their tested content", () => {
  const privacy = page("privacy.html");
  for (const p of ["Fly", "Neon", "Cloudflare", "Resend", "Sentry"]) assert.match(privacy, new RegExp(p));
  assert.doesNotMatch(privacy, /Clerk/);
  const design = page("design.html");
  assert.match(design, /#14213D/);
  assert.match(design, /#00C2A8/);
  assert.match(design, /src="\/mark\.svg"/);
  assert.match(design, /src="\/og\.png"/);
  assert.match(design, /src="\/og-square\.png"/);
  assert.match(design, /src="\/logo\.png"/);
  const grok = page("docs/connect/grok.html");
  assert.doesNotMatch(grok, /paste a Clerk JWT/i);
  assert.match(grok, /data-testid="docs-search"/);
  assert.match(text(grok), /grok mcp add --transport http botpasses https:\/\/botpasses\.com\/mcp/);
  assert.doesNotMatch(grok, /<h2[^>]*>Spotify<\/h2>/, "Spotify moved to the OAuth client secret how-to");
  const claudeCode = text(page("docs/connect/claude-code.html"));
  assert.match(claudeCode, /claude mcp add --transport http botpasses https:\/\/botpasses\.com\/mcp/);
  const cursor = text(page("docs/connect/cursor.html"));
  assert.match(cursor, /"url": "https:\/\/botpasses\.com\/mcp"/);
  assert.match(cursor, /"args": \["vault", "mcp"\]/);
  const oauthHowTo = text(page("docs/how-to/use-an-oauth-client-secret.html"));
  assert.match(oauthHowTo, /https:\/\/botpasses\.com\/connect\/callback/);
  assert.match(oauthHowTo, /https:\/\/staging\.botpasses\.com\/connect\/callback/);
  assert.match(oauthHowTo, /http:\/\/127\.0\.0\.1:8888\/callback/);
  const revoke = page("docs/how-to/revoke-access.html");
  assert.match(revoke, /Access/);
  const start = text(page("docs/start.html"));
  assert.match(start, /2\. Connect an agent/);
  assert.match(start, /3\. Set up a credential/);
  assert.match(start, /Set up Spotify so you can call the API for me/);
  const guided = text(page("docs/how-to/guided-setup.html"));
  assert.match(guided, /setup/);
  assert.match(guided, /Always allow this agent to use this credential/);
  assert.match(guided, /https:\/\/botpasses\.com\/connect\/callback/);
  const mcp = page("docs/reference/mcp-tools.html");
  assert.match(mcp, /http_request/);
  assert.match(mcp, /setup/);
  assert.match(mcp, /http\.request/, "the alias is named once");
  assert.match(mcp, /find_items/);
  assert.match(mcp, /get_secret/);
  assert.match(mcp, /collect_url/);
  assert.match(mcp, /task_id/);
  assert.match(mcp, /<summary>Instructions the server sends to the model<\/summary>/);
  const httpApi = page("docs/reference/http-api.html");
  for (const route of ["/api/access", "/oauth/revoke", "/runtime/resolve", "X-CSRF-Token", "/api/folders", "/api/orgs", "/approve", "/connect/callback", "/integrations/:provider/callback", "GET /mcp", "/llms.txt", "/llms-full.txt"]) {
    assert.match(httpApi, new RegExp(route.replace(/\//g, "\\/")), route);
  }
  const trouble = page("docs/troubleshooting.html");
  for (const id of ["host_mismatch", "mfa_required", "the-connect-card-keeps-appearing", "409-on-an-approval-code", "need_item-and-collect_url", "429-rate-limit"]) {
    assert.match(trouble, new RegExp(`id="${id}"`), id);
  }
  const faq = text(page("docs/faq.html"));
  assert.match(faq, /The model does not get the key/);
  assert.doesNotMatch(faq, /The model never sees the value/);
  const index = page("docs.html");
  assert.match(index, /MCP tools/);
  assert.match(index, /HTTP API/);
  const changelog = page("changelog.html");
  assert.match(changelog, /0\.4\.1/);
  assert.match(changelog, /0\.2\.0/);
  assert.match(changelog, /id="unreleased"/);
});
