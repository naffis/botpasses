# Agent Grant Vault

Named secrets for **agents and tools**, injected into the **tool/runtime**, never into the **model context or transcript**.

This is not a human password manager. It does not do browser autofill, TOTP, passkeys, or sharing secrets with other people. If the LLM can see a secret value, the product failed.

Ticket: **DAV-42**.

## Product intent

Operators store a named secret once (API key, token, password). Agents ask for a **grant** to use that name with a named tool. After a human approves, the vault injects the plaintext into the **child process environment** of that tool. Chat, MCP tool results, the operator console, and the audit log show **name + last-4 / grant metadata only**.

One vault. Many agents. Grants are scoped to `(secret, agent, tool)`.

## v1 working path

1. `vault set NAME` — store encrypted at rest. Output is `NAME ••••last4`.
2. Agent calls MCP `request_grant` for a named secret and named tool.
3. Operator approves with `vault grant` (once or session) or the loopback console.
4. `vault run --with NAME --agent AGENT --tool TOOL -- command` injects the value into the child env. Chat records that a grant happened.
5. `vault revoke` and `vault audit` — who, which secret name, which tool/agent, when, grant vs revoke. Audit never stores the value.
6. The same SQLite vault serves every agent.

## What this is not

- A LastPass / 1Password / Bitwarden clone
- Browser login filling
- Ingesting someone else's password vault
- TOTP or passkeys as a product
- Human-to-human secret sharing
- An MCP/API tool that returns plaintext to the model (`get_secret` does not exist)

## Threat model

| Surface | Sees secret value? |
| --- | --- |
| MCP tools (`list_secrets`, `request_grant`, `list_grants`, `revoke_grant`) | **No** — names, last-4, grant status |
| Operator console / HTTP JSON | **No** after submit — name + last-4 |
| CLI `list` / `grant` / `audit` | **No** |
| Audit SQLite table | **No** — no value column |
| Secrets SQLite table | Ciphertext only (AES-256-GCM envelope) |
| `vault run` child process env | **Yes** — that is the inject. The process that received the inject still holds plaintext. Treat that process as a secret holder. |
| Model context / chat transcript | **Must not.** Tests fail if a canary value appears after store, grant, or use. |

The vault master key decrypts every envelope. Anyone who can read `VAULT_MASTER_KEY` or `VAULT_HOME/master.key` and the SQLite file can decrypt. Keep both off the model and out of git.

v1 is local and loopback. It is not a multi-tenant KMS.

## Hard rules (enforced in code + tests)

- No MCP/API tool returns secret **values** to the model.
- MCP may list **names**, request a grant, report grant status, revoke.
- Values stay in the vault process until `run` copies them into a child env.
- Encryption is boring envelope AES-256-GCM via Node `crypto`. No novel KMS.
- Tests prove a mocked LLM/agent conversation cannot contain the stored secret after store, grant, or use.

## Requirements

- Node.js 22.14+
- `VAULT_MASTER_KEY` — 32 bytes as **64 hex characters** (preferred) or standard base64

## How to run locally

```bash
npm install
export VAULT_HOME="$PWD/.vault"
npx vault init
# vault init prints: export VAULT_MASTER_KEY=...
# or uses the generated file $VAULT_HOME/master.key (mode 0600)

printf '%s' 'sk_test_example_not_real' | npx vault set STRIPE_KEY
npx vault list
npx vault grant --secret STRIPE_KEY --agent invoicer --tool stripe --once
npx vault run --with STRIPE_KEY --agent invoicer --tool stripe -- \
  node -e 'console.log("injected", Boolean(process.env.STRIPE_KEY), "last4", (process.env.STRIPE_KEY||"").slice(-4))'
npx vault audit
npx vault revoke --secret STRIPE_KEY --agent invoicer --tool stripe
```

Prefer stdin for `vault set` so the value is not visible in `ps`. `--value` is for scripts and tests only.

### Master key

```bash
# Preferred: environment (do not commit)
export VAULT_MASTER_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"

# vault init will write $VAULT_HOME/master.key if the env var is unset.
# Env wins over the file.
```

`.env.example` documents the variables. Never put real production secrets in this repo.

### Operator console + HTTP + MCP (one process)

```bash
npx vault serve --host 127.0.0.1 --port 8787
```

- Console: `http://127.0.0.1:8787/` — store, approve, revoke, audit. Values are cleared after submit.
- JSON: `/api/secrets`, `/api/grants`, `/api/audit` — metadata only. There is no `/api/inject` that returns plaintext.
- MCP JSON-RPC: `POST /mcp`
- Bind defaults to loopback.

### MCP (stdio)

```json
{
  "mcpServers": {
    "agent-vault": {
      "command": "npx",
      "args": ["vault", "mcp"],
      "env": {
        "VAULT_HOME": "/absolute/path/.vault",
        "VAULT_MASTER_KEY": "set-me"
      }
    }
  }
}
```

| Tool | Returns |
| --- | --- |
| `list_secrets` | names, last-4, timestamps |
| `request_grant` | pending grant metadata (agent cannot self-approve) |
| `list_grants` | grant status |
| `revoke_grant` | revoked grant metadata |

There is no `get_secret` / `read_value` tool. Approval is `vault grant` or the operator console.

## CLI

| Command | Purpose |
| --- | --- |
| `vault init` | Create `$VAULT_HOME` + SQLite schema; generate key if needed |
| `vault set NAME` | Encrypt and store. Prints name + last-4 |
| `vault list` | Names + last-4 |
| `vault grant --secret NAME --agent A --tool T [--once\|--session] [--ttl 8h]` | Human approval |
| `vault revoke --id GRANT_ID` | Stop future injects |
| `vault audit` | Grant/revoke/store/inject events, no values |
| `vault run --with NAME --agent A --tool T -- CMD` | Inject into child env without printing |
| `vault serve` | Loopback HTTP + operator console + `/mcp` |
| `vault mcp` | MCP stdio |

`--session` grants expire after `--ttl` (default 8h) or when revoked. `--once` is consumed after a single successful inject.

## Encryption

Each secret is an AES-256-GCM envelope: random 12-byte IV, ciphertext, 16-byte auth tag, stored as base64 in SQLite. The 32-byte master key from `VAULT_MASTER_KEY` (or `master.key`) is the AES key. A SHA-256 fingerprint of the key is stored in `vault_meta` so a wrong key fails closed.

This is ordinary envelope encryption. It is not a novel KMS.

## Tests

```bash
npm test
npm run typecheck
```

The isolation tests store a canary value, drive a mocked agent conversation (MCP list/request/list grants/revoke + operator grant + `run`), and fail if that canary appears in the transcript, MCP results, audit JSON, CLI output, or the SQLite file. A separate probe file (not part of the transcript) asserts the child process **did** receive the plaintext.

## Layout

```
src/          vault, crypto, sqlite, CLI, HTTP+MCP
test/         isolation, MCP allowlist, CLI, HTTP
bin/vault.js  Node 22 launcher
```
