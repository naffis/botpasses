import { groupBySection, sortDocs, toNavItems, type DocEntry } from "./docs-nav.ts";
import { GITHUB, SITE_URL } from "./site-meta.ts";

const QUOTE =
  "Botpasses is a grant-vault for AI agents. You store an API key once. An agent (Claude, Cursor, ChatGPT, Grok, or any MCP client) calls the API through Botpasses over MCP; the key is attached inside the vault and does not enter the chat, the model, or the logs. Grant-vault, not zero-knowledge: the hosted process decrypts only at an approved inject.";

const MCP_LINE =
  "MCP endpoint: https://botpasses.com/mcp (OAuth 2.1 with PKCE and dynamic client registration on botpasses.com, or a console-issued bearer token). Primary tool: http_request. Also find_items, list_items, request_grant, list_grants, setup. There is no get_secret.";

/** Curated index at /llms.txt. Docs links come from the content collection so new pages cannot be forgotten. */
export function renderLlmsIndex(docs: DocEntry[]): string {
  const groups = groupBySection(toNavItems(docs));
  const lines = [
    "# Botpasses",
    "",
    `> ${QUOTE}`,
    "",
    MCP_LINE,
    "",
    "## Facts",
    "",
    "- Not a password manager. Credentials are for agents, not browser autofill.",
    "- Not zero-knowledge. The hosted process decrypts at inject. Staff need both the AWS KMS role and the database.",
    "- Hosted at https://botpasses.com. Staging at https://staging.botpasses.com has its own accounts.",
    "- MIT licensed. Free while in beta. Source: https://github.com/naffis/botpasses",
    "",
    "## Docs",
    "",
  ];
  for (const g of groups) {
    lines.push(`### ${g.label}`, "");
    for (const i of g.items) {
      lines.push(`- [${i.title}](${SITE_URL}${i.href}): ${i.description}`);
    }
    lines.push("");
  }
  lines.push(
    "## Security",
    "",
    `- [Security](${SITE_URL}/security): trust model, encryption, connector hardening, canary tests`,
    `- [security.txt](${SITE_URL}/.well-known/security.txt)`,
    "",
    "## Source",
    "",
    `- [GitHub](${GITHUB}): MIT licensed`,
    `- [Changelog](${SITE_URL}/changelog)`,
    "",
    "## Optional",
    "",
    `- [Full docs for models](${SITE_URL}/llms-full.txt): every documentation page in one file`,
    "",
  );
  return lines.join("\n");
}

export type DocWithBody = DocEntry & { body?: string };

/** Full documentation dump at /llms-full.txt, generated at site build. */
export function renderLlmsFull(docs: DocWithBody[]): string {
  const parts = [
    "# Botpasses",
    "",
    `> ${QUOTE}`,
    "",
    MCP_LINE,
    "",
    "This file is every documentation page, generated at site build. The short index is https://botpasses.com/llms.txt.",
    "",
  ];
  for (const d of sortDocs(docs)) {
    const body = (d.body ?? d.data.description).trim();
    parts.push(`# ${d.data.title}`, "", body, "", "");
  }
  return parts.join("\n");
}
