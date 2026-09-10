/** Paste-ready bootstrap prompts. Homepage copy buttons and docs pages share this list. */

export type BootstrapPromptId =
  | "hosted"
  | "local"
  | "self-host"
  | "first-api"
  | "second-agent"
  | "staging"
  | "grok-redirect";

export type BootstrapPrompt = {
  id: BootstrapPromptId;
  title: string;
  /** Docs heading; Astro slugs this to the fragment id. */
  heading: string;
  blurb: string;
  text: string;
};

export const BOOTSTRAP_PROMPTS: readonly BootstrapPrompt[] = [
  {
    id: "hosted",
    title: "Hosted agent",
    heading: "Hosted",
    blurb:
      "Paste into Claude, Cursor, ChatGPT, or Grok after you add https://botpasses.com/mcp. Your agent walks the Collect and Connect links; you type secrets on botpasses.com.",
    text: `You are setting up Botpasses for me (https://botpasses.com). Botpasses is a grant-vault for agents: I store API credentials once; you call APIs through MCP; the key is attached inside the vault and must never appear in chat, logs, or your context. There is no get_secret.

Do this end to end. Pause and give me a link or checkbox whenever a human step is required. Do not ask me to paste secrets into this chat.

1. Confirm Botpasses MCP is connected.
   - Hosted MCP URL: https://botpasses.com/mcp
   - If tools are missing, tell me which client I am on and open the matching docs:
     Cursor https://botpasses.com/docs/connect/cursor
     Claude https://botpasses.com/docs/connect/claude
     Claude Code https://botpasses.com/docs/connect/claude-code
     ChatGPT https://botpasses.com/docs/connect/chatgpt
     Grok https://botpasses.com/docs/connect/grok
   - Grok often needs a console-issued bearer (avm_\u2026) as Authorization: Bearer <token> (single Bearer, no double Bearer). If tools/call falls into OAuth redirect_uri errors, say so and point me at a one-time model token from the Botpasses console.

2. Call the setup tool for the first API I name (default: Spotify if I do not name one). Prefer provider=spotify|stripe|github|google|slack, or host= for other APIs.

3. When setup returns collect_url, give me that URL only. Tell me to open it, sign in, type the credential there, and never paste the value here. For Client ID and secret kinds, remind me the redirect URI on the provider app is https://botpasses.com/connect/callback.

4. If setup or http_request returns connect_url (user OAuth, e.g. Spotify /v1/me), give me that console link and wait until I confirm Connect is done.

5. Prefer Always-allow only when I say so. Otherwise one-shot Inbox approvals are fine.

6. When status is ready, smoke a read-only call (for Spotify: GET /v1/search or /v1/me after Connect). Report origin status and a short redacted summary. Do not print tokens.

7. Stop with: (a) item name, (b) hosts, (c) whether user Connect is done, (d) one example ask I can type next in plain language.

If anything fails (need_item, host_mismatch, mfa_required, 429, redirect_uri), use https://botpasses.com/docs/troubleshooting and keep secrets out of chat.`,
  },
  {
    id: "local",
    title: "Local machine",
    heading: "Local",
    blurb: "For a laptop vault with SQLite. No botpasses.com account required. Same MCP tools as hosted.",
    text: `Set up a local Botpasses vault on this machine and wire it into my MCP client. Secrets must never enter chat.

Facts:
- Repo: https://github.com/naffis/botpasses (MIT). npm package not published yet; run CLI from a clone.
- Need Node.js 22.14+.
- Local home: set VAULT_HOME to an absolute path (e.g. $PWD/.botpasses or $HOME/.botpasses).
- Local MCP exposes the same six tools as hosted: list_items, find_items, request_grant, list_grants, setup, http_request. Values inject only into approved calls or vault run child env.

Steps:
1. Clone (or reuse) the repo, npm install, export VAULT_HOME to an absolute path, run npx vault init if the vault does not exist. Do not print the master key into chat; tell me where it lives and that I must keep VAULT_MASTER_KEY out of transcripts.
2. Show me the mcp.json snippet for my client (Cursor ~/.cursor/mcp.json or project .cursor/mcp.json) using command npx with args ["vault","mcp"] and env names VAULT_HOME and VAULT_MASTER_KEY (references only, never a literal key). I paste or approve the file edit; you do not echo the master key value in the reply.
3. After MCP connects, call list_items to prove the server is up.
4. For the first secret I name (or Stripe test key if I say so), use setup so I get a collect_url, or tell me to run npx vault set NAME in my own terminal so the CLI can prompt. Do not accept the value in this chat. Do not write a command that contains the secret. Then vault grant --secret NAME --agent <name my client sends on initialize> --tool http_request (once or standing as I choose).
5. Smoke http_request to an allowlisted host I approve. Report status only.
6. Point me at https://botpasses.com/docs/install and https://botpasses.com/docs/reference/cli for vault run (child process inject) when I need CLI scripts instead of MCP.

If I already have a hosted account and only need stdio to hosted: use VAULT_PUBLIC_URL=https://botpasses.com, vault login, vault mcp --user-jwt. Still never paste JWTs into chat; use env on the machine.`,
  },
  {
    id: "self-host",
    title: "Self-host",
    heading: "Self-host",
    blurb:
      "Run the same hosted process on your plane. One machine, Postgres (any vendor), KMS-wrapped platform key, custom https origin. Swap botpasses.com for your origin in agent prompts and OAuth redirect URIs.",
    text: `Help me deploy a self-hosted Botpasses plane from https://github.com/naffis/botpasses. Goal: a private grant-vault my agents hit at our origin (not necessarily botpasses.com). Follow docs/self-hosting and docs/ops in the repo. Do not invent secret values; ask me to set them in the secret store.

Reference shape (adapt to our cloud if we are not on Fly):
- One Node process: VAULT_MODE=hosted vault serve (one Machine per plane; in-memory enroll/rate-limit state).
- Postgres 16 (any vendor): separate database per plane; pooled DATABASE_URL + direct DATABASE_URL_DIRECT.
- Edge DNS/WAF (Cloudflare or ours) with SSL full strict.
- AWS KMS (or approved KMS) wrapping VAULT_KEK_WRAPPED; VAULT_KMS_APP_ID or FLY_APP_NAME; Fly OIDC or equivalent for AWS_ROLE_ARN.
- Email provider for codes (Resend pattern: RESEND_API_KEY + VAULT_EMAIL_FROM).
- Optional: R2/S3 encrypted backups, Sentry without values.
- Laptop hosted kernel is npm run hosted:dev (VAULT_DEPLOY_PLANE=dev, loopback, sqlite). That plane is refused when FLY_APP_NAME is set.

Required config checklist (confirm each is set in secrets, never paste into chat):
DATABASE_URL (Postgres URL), DATABASE_URL_DIRECT, VAULT_PUBLIC_URL (our https origin), VAULT_DEPLOY_PLANE (staging|production), VAULT_KEK_WRAPPED, VAULT_KMS_KEY_ID, VAULT_KMS_APP_ID or FLY_APP_NAME, AWS_ROLE_ARN, VAULT_KEK_REQUIRE_KMS=1 after cutover, VAULT_SESSION_SECRET (>=32 bytes), VAULT_OIDC_PRIVATE_JWK, VAULT_APPROVAL_HMAC (64 hex), bootstrap token pair only for break-glass window, VAULT_TRUST_PROXY as appropriate.

Build:
npm ci
npm --prefix site ci && npm --prefix site run build
VAULT_MODE=hosted VAULT_BIND_HOST=0.0.0.0 PORT=8788 npx vault serve
Exit 78 means config is wrong; fix from the self-hosting table.

After /health and /ready pass:
1. Create the first operator account on our VAULT_PUBLIC_URL (email code + TOTP).
2. Issue a model/agent token or complete OAuth for our MCP clients against https://<our-origin>/mcp.
3. Give developers the hosted agent bootstrap prompt, with every botpasses.com URL replaced by our origin (including /connect/callback on provider apps).
4. Write a short internal runbook: who holds KMS, how to revoke an agent, how to rotate KEK (vault kek-rotate), backup restore pointer under docs/ops.

Constraints: do not scale to two Machines without moving in-memory state to the database. Do not branch production Postgres from staging. Never log or return credential values.`,
  },
  {
    id: "first-api",
    title: "First API only",
    heading: "First API only",
    blurb: "MCP is already connected. The agent runs setup for one API and gives you Collect and Connect links.",
    text: `Botpasses MCP should already be connected. Call setup for <spotify|stripe|github|google|slack or host=\u2026>. Give me collect_url (and connect_url if needed). I will type secrets on Botpasses only. When ready, run one read-only smoke and tell me the item name and a plain-language ask to use next.`,
  },
  {
    id: "second-agent",
    title: "Second agent",
    heading: "Second agent",
    blurb: "A second client on the same hosted vault. Grants for items you already stored. No new secrets unless needed.",
    text: `I already have Botpasses working for one client. Help a second agent (name the client) connect to the same hosted vault at https://botpasses.com/mcp, store nothing new unless needed, request grants for the existing item names I list, and use Always-allow only if I say so. Keep staging agents off production credentials.`,
  },
  {
    id: "staging",
    title: "Staging",
    heading: "Staging",
    blurb: "Dogfood on staging.botpasses.com. Separate accounts from production.",
    text: `Use https://staging.botpasses.com (separate accounts from production). Connect MCP to https://staging.botpasses.com/mcp, set up a test credential, smoke one call, and remind me production agents cannot use staging items and vice versa.`,
  },
  {
    id: "grok-redirect",
    title: "Grok redirect_uri",
    heading: "Grok redirect_uri",
    blurb: "Tools list works but tools/call fails with redirect_uri. Prefer a console-issued avm_ bearer.",
    text: `My Botpasses MCP lists tools but tools/call fails with redirect_uri or Model OAuth required. Diagnose against https://botpasses.com/docs/connect/grok and troubleshooting. Prefer a console-issued avm_ bearer as Authorization: Bearer <token> (one Bearer prefix). Do not put the token in chat; use the client's secret/env field. Re-test list_items then a setup or http_request.`,
  },
];

const BY_ID = new Map(BOOTSTRAP_PROMPTS.map((p) => [p.id, p]));

export function promptById(id: BootstrapPromptId): BootstrapPrompt {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown bootstrap prompt: ${id}`);
  return found;
}

export const PRIMARY_PROMPT_IDS = ["hosted", "local", "self-host"] as const satisfies readonly BootstrapPromptId[];

export const EXTRA_PROMPT_IDS = [
  "first-api",
  "second-agent",
  "staging",
  "grok-redirect",
] as const satisfies readonly BootstrapPromptId[];
