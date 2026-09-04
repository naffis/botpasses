# AGENTS.md

Cross-tool baseline conventions, read by Cursor and other agents. Keep it THIN — only what
applies broadly. Situational knowledge belongs in a skill (loaded on demand), not here.
Litmus test per line: "would removing this cause an agent to make a mistake?" If not, cut it.

## Stack

- TypeScript (Node.js 22.14+, ESM, `--experimental-strip-types` — no compile step for run)
- SQLite vault at `$VAULT_HOME` (default `$HOME/.botpasses`) · AES-256-GCM envelope encryption
- MCP (stdio + HTTP) + CLI (`npx vault` / `npm run botpasses`) + loopback operator console
- Hosted origins: `https://botpasses.com`, `https://staging.botpasses.com`. Never a platform default hostname.
- Hosted identity is first-party (email OTP + TOTP). This origin is the MCP OAuth authorization server. No Clerk.
- Hosted plane KEK: prefer `VAULT_KEK_WRAPPED` + KMS. `VAULT_KEK_REQUIRE_KMS=1` refuses raw-only. Do not claim zero-knowledge.
- Hosted durability is Neon (PITR + isolated projects) plus a fail-closed encrypted `pg_dump` to R2 (`BACKUP_KEY` ≠ KEK). SQLite is the local CLI only. Restore: `docs/ops/restore.md`.

## Commands

- Install: `npm ci`, then `npm run site:build` once (tests read `site/dist`)
- Dev / CLI: `npx vault <command>` (set `VAULT_HOME` and `VAULT_MASTER_KEY`)
- Test: `npm test` (prefer a focused file: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-reporter=spec test/<file>.test.ts`)
- Typecheck: `npm run typecheck` · Lint: `npm run lint` · Postgres tests: `npm run test:pg` (needs `DATABASE_URL`)
- Schema: expand-only; add to `src/store/schema.ts` and a numbered file in `migrations/` (`npm run migrate` applies them; a Postgres test asserts parity)
- Console client: edit `src/hosted/client/*.ts`, then `node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/build-client.ts` to regenerate the committed bundle

## Conventions

- Secrets are injected into **tool/runtime env only**. Never into model context, MCP tool results, operator console JSON, audit logs, or chat. There is no `get_secret`.
- MCP may list names, find by exact name or API host, request a grant, report grant status. A miss returns a path-only Botpasses `collect_url` (no HMAC). The operator types the secret on that origin. Values stay in the vault process until `vault run` or `http.request`. Tool and HTTP contracts: `docs/reference/mcp.md`, `docs/reference/http-api.md`.
- Tests must fail if a canary secret appears in a mocked LLM/agent conversation after store, grant, or use.
- `master.key`, `.botpasses/`, `.vault/`, and `.env` stay out of git.

## Workflow

- Smallest safe change; follow existing patterns; verify with `npm test && npm run typecheck` before claiming done.
- Integration trunk: `dev`. Parallel agents share one local trunk checkout — no per-agent branches/worktrees/stashes; when asked to commit, land all eligible dirty files (`committing-on-shared-trunk`).
- Branch/PR etiquette: PRs only when explicitly asked · target `dev` · conventional commits.

## Do not

- Commit secrets, master keys, or PII; read them from env / `$VAULT_HOME/master.key`.
- Return a secret **value** from any MCP/API/CLI list/grant/audit path.
- `git stash`, create a feature branch, or selectively stage "only my files".
- Bind local servers to port 8787 (Cursor MCP OAuth loopback). Product HTTP listens on **8788**.
