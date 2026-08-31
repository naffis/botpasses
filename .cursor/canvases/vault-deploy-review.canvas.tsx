import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  TodoList,
} from "cursor/canvas";

const setupTodos = [
  {
    id: "node",
    content: "Install Node.js 22.14+ (engines field; CI uses 22). Confirm with node -v.",
    status: "pending" as const,
  },
  {
    id: "install",
    content: "From the repo: npm ci && npm test && npm run typecheck",
    status: "pending" as const,
  },
  {
    id: "home",
    content:
      "Pick a data dir outside the repo (recommended: ~/.agent-vault). chmod 700. Do not use $PWD/.vault if the project is backed up or shared.",
    status: "pending" as const,
  },
  {
    id: "init",
    content:
      "VAULT_HOME=~/.agent-vault npx vault init. Prefer the generated ~/.agent-vault/master.key (mode 0600). Do not export the printed key into shell history or mcp.json.",
    status: "pending" as const,
  },
  {
    id: "store",
    content:
      "Store secrets via stdin, not --value: printf '%s' '…' | VAULT_HOME=~/.agent-vault npx vault set STRIPE_KEY",
    status: "pending" as const,
  },
  {
    id: "mcp",
    content:
      "Register Cursor MCP stdio (command: node bin/vault.js mcp) with VAULT_HOME only. Omit VAULT_MASTER_KEY so the key stays in master.key, not in a file the model can read.",
    status: "pending" as const,
  },
  {
    id: "console",
    content:
      "Optional operator console: npx vault serve --host 127.0.0.1 --port 8788. Never 8787 (Cursor MCP OAuth). Never 0.0.0.0.",
    status: "pending" as const,
  },
  {
    id: "wrap",
    content:
      "Wrap any tool that needs a secret: vault run --with NAME --agent A --tool T -- <cmd>. MCP cannot inject. Existing Stripe/Twilio MCP servers will not see vault secrets unless you wrap their process.",
    status: "pending" as const,
  },
];

export default function VaultDeployReview() {
  return (
    <Stack gap={24}>
      <Stack gap={8}>
        <H1>Agent Grant Vault — review and deploy</H1>
        <Text tone="secondary">
          Source: local dest at f7e3183 · 27 files · ~3k lines · DAV-42 v1. This
          is a workstation process, not a cloud service.
        </Text>
      </Stack>

      <Callout tone="warning" title="Do not deploy this to Workers, Vercel, or a public host">
        v1 is a local Node process that holds a master key, opens a SQLite file,
        and spawn()s child processes to inject plaintext into their env. There is
        no auth on HTTP. Binding anything other than 127.0.0.1, or putting
        VAULT_MASTER_KEY in a cloud env next to a public URL, breaks the product.
      </Callout>

      <Row gap={16}>
        <Stat value="local" label="Intended deploy" tone="info" />
        <Stat value="none" label="HTTP auth" tone="warning" />
        <Stat value="8787" label="Default port — conflicts" tone="danger" />
        <Stat value="stdio" label="Cursor MCP mode" />
      </Row>

      <H2>How it should run</H2>
      <Text>
        One operator laptop. One vault home. Three entrypoints that all open the
        same SQLite file. The model only talks to MCP. The operator approves.
        The inject happens in a child the operator (or a wrapper) starts.
      </Text>

      <Table
        headers={["Process", "How you start it", "Sees secret value?", "Role"]}
        rows={[
          [
            "vault mcp",
            "Cursor MCP stdio",
            "No",
            "list / request_grant / list_grants / revoke. Agent cannot approve.",
          ],
          [
            "vault serve",
            "Optional loopback HTTP",
            "Only at store submit",
            "Operator console + /api/* metadata + POST /mcp. No /api/inject.",
          ],
          [
            "vault CLI",
            "Terminal",
            "stdin on set; child env on run",
            "init, set, grant, revoke, audit, run.",
          ],
          [
            "vault run child",
            "Wrapped tool command",
            "Yes — that is the inject",
            "Receives NAME=plaintext in env. Treat that process as a secret holder.",
          ],
        ]}
        rowTone={["info", "warning", "neutral", "success"]}
        striped
      />

      <Callout tone="info" title="The integration gap">
        MCP is a grant protocol, not an injector. Cursor-spawned MCP servers
        (Stripe, Twilio, etc.) are not children of vault run, so they will not
        receive vault secrets. v1 only injects into commands you wrap. Until a
        tool runner exists, this vault stores and gates — it does not
        automatically secret-inject the rest of the agent toolchain.
      </Callout>

      <H2>What you need</H2>
      <Grid columns={2} gap={16}>
        <Card>
          <CardHeader trailing={<Pill size="sm" active>required</Pill>}>
            Runtime
          </CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text>Node.js 22.14+ (uses node:sqlite and --experimental-strip-types).</Text>
              <Text>This checkout. Not published to npm. Invoke via npx vault or node bin/vault.js.</Text>
              <Text>A private directory for vault.sqlite + optional master.key. Default is ~/.agent-vault.</Text>
            </Stack>
          </CardBody>
        </Card>
        <Card>
          <CardHeader trailing={<Pill size="sm" active>required</Pill>}>
            Secrets on disk
          </CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text>
                VAULT_MASTER_KEY — 32 bytes as 64 hex chars (or base64). Env wins
                over $VAULT_HOME/master.key.
              </Text>
              <Text>
                The key decrypts every envelope. Anyone with the key and
                vault.sqlite has every secret. Keep both off git, backups that
                leave the machine, and any file the model can read.
              </Text>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <Table
        headers={["Variable", "Required", "Where to put it", "Notes"]}
        rows={[
          [
            "VAULT_HOME",
            "Yes in practice",
            "shell profile + Cursor MCP env",
            "Absolute path. Default ~/.agent-vault. Mode 0700.",
          ],
          [
            "VAULT_MASTER_KEY",
            "Or master.key file",
            "env for CLI; omit from mcp.json",
            "If unset, loadMasterKey reads $VAULT_HOME/master.key. Prefer the file for MCP so the model cannot read the key from Cursor config.",
          ],
          [
            "VAULT_ACTOR",
            "No",
            "optional env",
            "Audit actor. Defaults to $USER.",
          ],
        ]}
        striped
      />

      <H2>Setup checklist</H2>
      <TodoList todos={setupTodos} />

      <H3>Cursor MCP snippet</H3>
      <Text tone="secondary">
        Point command at this repo. Do not put the master key in the JSON.
      </Text>
      <Text>
        {`{
  "mcpServers": {
    "agent-vault": {
      "command": "node",
      "args": ["/Users/naffis/projects/agent-vault/bin/vault.js", "mcp"],
      "env": {
        "VAULT_HOME": "/Users/naffis/.agent-vault"
      }
    }
  }
}`}
      </Text>

      <H3>Operator console</H3>
      <Text>
        {`VAULT_HOME=~/.agent-vault npx vault serve --host 127.0.0.1 --port 8788`}
      </Text>
      <Text tone="secondary">
        Then grant from the console or: npx vault grant --secret STRIPE_KEY
        --agent invoicer --tool stripe --once
      </Text>

      <H3>Inject (the only path that decrypts)</H3>
      <Text>
        {`npx vault run --with STRIPE_KEY --agent invoicer --tool stripe -- \\
  your-tool --flags`}
      </Text>

      <Divider />

      <H2>Code review</H2>
      <Text>
        The isolation story is real: AES-256-GCM envelopes, no get_secret tool,
        canary tests fail if the value appears in MCP, audit, CLI, or SQLite.
        The deploy story is thinner. Findings below are about running this on a
        real operator machine, not style.
      </Text>

      <Table
        headers={["Severity", "Finding", "Where", "What to do"]}
        rows={[
          [
            "Blocker for cloud",
            "HTTP has no auth, no CSRF, no body-size cap. Any local process or drive-by localhost POST can store, approve, or revoke.",
            "src/server.ts",
            "Keep bind at 127.0.0.1. Do not expose. Add a shared-secret header before any non-loopback use.",
          ],
          [
            "High",
            "Default serve port 8787 is Cursor's MCP OAuth loopback. Local serve and Cursor auth will collide.",
            "src/cli.ts, src/server.ts, README",
            "Change default to 8788. Document the conflict.",
          ],
          [
            "High",
            "No tool-runner integration. MCP cannot inject. Existing MCP tools never receive vault secrets.",
            "src/mcp.ts vs src/vault.ts runWithSecrets",
            "Treat vault run wrappers as required for v1, or build a spawn interceptor later.",
          ],
          [
            "High",
            "Putting VAULT_MASTER_KEY in Cursor mcp.json hands the unwrap key to anything that can read that file — including the agent.",
            "README MCP example",
            "MCP env = VAULT_HOME only. Key stays in master.key 0600.",
          ],
          [
            "Medium",
            "vault init prints the generated key to stdout (shell history).",
            "src/cli.ts cmdInit",
            "Print fingerprint only. Tell the operator the file path.",
          ],
          [
            "Medium",
            "Multiple processes (mcp + serve + CLI) each open DatabaseSync on the same file. No busy_timeout. WAL is on, but SQLITE_BUSY can throw under concurrent grant/run.",
            "src/db.ts openDb",
            "PRAGMA busy_timeout = 5000 before first write.",
          ],
          [
            "Medium",
            "Operator console builds HTML with string concat (innerHTML). Secret names and grant ids are not escaped.",
            "src/operator-page.ts",
            "textContent or escape. Names are constrained, but still XSS-shaped.",
          ],
          [
            "Medium",
            "vault run copies process.env into the child, then deletes only VAULT_MASTER_KEY. Other secrets already in the operator shell leak into the tool.",
            "src/vault.ts runWithSecrets",
            "Start from a allowlist env, or strip known secret-shaped vars.",
          ],
          [
            "Low",
            "CI push trigger is main + cursor/** only. dest pushes will not run tests.",
            ".github/workflows/ci.yml",
            "Add dest.",
          ],
          [
            "Low",
            "serve --host is unconstrained. An operator can bind 0.0.0.0 with no warning.",
            "src/cli.ts cmdServe",
            "Refuse non-loopback unless --i-mean-it, and log a loud warning.",
          ],
          [
            "OK as designed",
            "AES-256-GCM, random 12-byte IV, auth tag, key fingerprint fail-closed, 64KiB cap, env-var secret names, agent cannot self-approve.",
            "src/crypto.ts, src/vault.ts, src/mcp.ts",
            "Keep. This is the product.",
          ],
        ]}
        rowTone={[
          "danger",
          "danger",
          "danger",
          "warning",
          "warning",
          "warning",
          "warning",
          "warning",
          "info",
          "info",
          "success",
        ]}
        striped
      />

      <H2>What not to stand up</H2>
      <Grid columns={2} gap={16}>
        <Stack gap={8}>
          <H3>Skip</H3>
          <Text>Cloudflare Worker / Durable Object — no child spawn, wrong persistence model, would need a different product.</Text>
          <Text>Vercel / public URL — unauthenticated grant + store API.</Text>
          <Text>Docker on a shared host with published ports.</Text>
          <Text>Checking master.key, .env, or vault.sqlite into git or 1Password-as-git.</Text>
        </Stack>
        <Stack gap={8}>
          <H3>Fine later, not v1</H3>
          <Text>launchd plist to keep vault serve on 8788 at login.</Text>
          <Text>A small wrapper script per tool (stripe, twilio, mercury) that calls vault run.</Text>
          <Text>Remote KMS / multi-operator / SSO. The README is explicit: not a multi-tenant KMS.</Text>
        </Stack>
      </Grid>

      <H2>Minimum viable operator day</H2>
      <Table
        headers={["Step", "Command / action", "Who"]}
        rows={[
          ["1. Init once", "VAULT_HOME=~/.agent-vault npx vault init", "operator"],
          ["2. Store", "printf '%s' '…' | npx vault set STRIPE_KEY", "operator"],
          ["3. Agent asks", "MCP request_grant", "agent"],
          ["4. Approve", "npx vault grant --secret STRIPE_KEY --agent invoicer --tool stripe --once", "operator"],
          ["5. Use", "npx vault run --with STRIPE_KEY --agent invoicer --tool stripe -- <cmd>", "operator / wrapper"],
          ["6. Review", "npx vault audit", "operator"],
        ]}
        striped
      />

      <Text tone="tertiary" size="small">
        Review of /Users/naffis/projects/agent-vault at dest f7e3183. Isolation
        tests and CI on the merged PR were green. No production host is in
        scope for this SHA.
      </Text>
    </Stack>
  );
}
