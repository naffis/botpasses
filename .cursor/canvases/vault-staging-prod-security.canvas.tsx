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

const hardenTodos = [
  {
    id: "auth",
    content:
      "Authn on every HTTP route (operator bearer or Cloudflare Access). Refuse to listen if credentials are unset.",
    status: "pending" as const,
  },
  {
    id: "bind",
    content:
      "Hard-refuse non-loopback bind unless auth is set. Prefer Unix socket. Never 0.0.0.0 on cleartext HTTP.",
    status: "pending" as const,
  },
  {
    id: "csrf",
    content:
      "Host + Origin allowlist and CSRF token on mutating routes. Close DNS-rebinding grant approval on 127.0.0.1.",
    status: "pending" as const,
  },
  {
    id: "mcp-http",
    content:
      "Remove POST /mcp from vault serve, or put it behind the same auth and a separate port. Agents use stdio on the runner.",
    status: "pending" as const,
  },
  {
    id: "once",
    content:
      "Atomic consume: BEGIN IMMEDIATE; UPDATE grants SET status='consumed' WHERE id=? AND status='active'; require changes=1 before decrypt.",
    status: "pending" as const,
  },
  {
    id: "limits",
    content:
      "Cap readJson (e.g. 128KiB). busy_timeout=5000. Change default port off 8787.",
    status: "pending" as const,
  },
  {
    id: "revoke",
    content:
      "Drop revoke_grant from agent MCP. Operator CLI/console only.",
    status: "pending" as const,
  },
  {
    id: "envs",
    content:
      "Two vaults, two keys, two disks. Staging = test/sandbox secrets only. Prod = live keys. Never copy sqlite or master.key across envs.",
    status: "pending" as const,
  },
];

export default function VaultStagingProdSecurity() {
  return (
    <Stack gap={24}>
      <Stack gap={8}>
        <H1>Staging / production security review</H1>
        <Text tone="secondary">
          Agent grant vault · dest f7e3183 vs main · DAV-42 · independent
          security pass plus full-tree review. Ticket: one vault, many agents,
          inject into the tool, never into the model.
        </Text>
      </Stack>

      <Callout tone="danger" title="Do not deploy this SHA to staging or production">
        The isolation model (no MCP plaintext, AES-256-GCM, grant-scoped
        vault run) is sound. vault serve is an unauthenticated control plane:
        store, approve, revoke, and HTTP MCP. That is fatal the moment the
        listener is reachable — including DNS rebinding against 127.0.0.1.
        There is also no environment split, no TLS, no operator identity, and
        no remote inject path that is not get_secret.
      </Callout>

      <Row gap={16}>
        <Stat value="No" label="Staging-ready" tone="danger" />
        <Stat value="No" label="Prod-ready" tone="danger" />
        <Stat value="2 crit" label="HTTP control plane" tone="danger" />
        <Stat value="OK" label="Model-channel isolation" tone="success" />
      </Row>

      <H2>What is already true</H2>
      <Text>
        If the LLM can see the value, the product failed. That bar is met on
        the CLI + stdio MCP + vault run path. Do not throw that away when you
        “make it a service.”
      </Text>
      <Table
        headers={["Control", "Verdict", "Evidence"]}
        rows={[
          [
            "MCP never returns plaintext",
            "Hold",
            "Allowlist only. Forbidden get_secret/read_value. Isolation canary tests.",
          ],
          [
            "Agent cannot self-approve",
            "Hold on MCP",
            "request_grant stays pending. Broken if HTTP POST /api/grants is reachable.",
          ],
          [
            "Inject is grant-scoped",
            "Hold",
            "runWithSecrets requires active (secret, agent, tool). Wrong agent denied.",
          ],
          [
            "At-rest crypto",
            "Hold for v1",
            "AES-256-GCM, random 12-byte IV, auth tag, key fingerprint fail-closed. Not a KMS.",
          ],
          [
            "SQL / command injection",
            "Hold",
            "Parameterized SQLite. spawn(bin, args) without a shell.",
          ],
          [
            "Child does not inherit master key",
            "Hold",
            "VAULT_MASTER_KEY deleted from child env. Rest of parent env is copied.",
          ],
        ]}
        rowTone={["success", "warning", "success", "success", "success", "info"]}
        striped
      />

      <H2>Security findings</H2>
      <Text tone="secondary">
        Sorted by severity. Independent review plus operational items for two
        environments.
      </Text>
      <Table
        headers={["Sev", "Location", "Finding"]}
        rows={[
          [
            "Critical",
            "server.ts:69",
            "No authn/authz on store, approve, revoke, list, audit, or POST /mcp. Reachable client = operator.",
          ],
          [
            "Critical",
            "cli.ts:276",
            "--host 0.0.0.0 is allowed. Cleartext HTTP then exposes the control plane on the network.",
          ],
          [
            "High",
            "server.ts:51",
            "No Host/Origin check. DNS rebinding or a same-machine page can approve grants while serve listens on 127.0.0.1.",
          ],
          [
            "High",
            "server.ts:115",
            "Full MCP on HTTP with no identity. Remote revoke + inventory if the port is open.",
          ],
          [
            "High",
            "product",
            "No inject-over-network design. A “vault API” that returns values is the anti-pattern DAV-42 forbids. Staging/prod runners must keep vault run on the same host as the tool.",
          ],
          [
            "Medium",
            "vault.ts:281",
            "once grants: check then consume is not atomic. Two vault run processes can both inject.",
          ],
          [
            "Medium",
            "mcp.ts:164",
            "revoke_grant is an agent tool. Any client that listed grants can revoke anyone’s.",
          ],
          [
            "Medium",
            "server.ts:143",
            "readJson buffers the whole body. 64KiB cap is on the secret, not the request. Memory DoS.",
          ],
          [
            "Medium",
            "vault.ts:274",
            "Child inherits the full operator env except the master key. Other live secrets in the shell leak into the tool.",
          ],
          [
            "Medium",
            "cli.ts:82",
            "vault init prints the generated master key to stdout (shell history, CI logs).",
          ],
          [
            "Medium",
            "mcp.ts:136",
            "list_secrets gives the model the full inventory + last-4. Fine for one operator; loud for a shared staging vault.",
          ],
          [
            "Low",
            "cli.ts:281",
            "Default port 8787 collides with Cursor MCP OAuth.",
          ],
          [
            "Low",
            "db.ts:248",
            "WAL on, no busy_timeout. Concurrent mcp + serve + CLI can throw SQLITE_BUSY.",
          ],
          [
            "Low",
            "ci.yml:5",
            "CI push branches are main and cursor/**. dest deploys will not be tested.",
          ],
        ]}
        rowTone={[
          "danger",
          "danger",
          "danger",
          "danger",
          "danger",
          "warning",
          "warning",
          "warning",
          "warning",
          "warning",
          "warning",
          "info",
          "info",
          "info",
        ]}
        striped
      />

      <H2>How staging and production should look</H2>
      <Text>
        Split the product the way the threat model already does. The model
        channel stays metadata-only. Decrypt stays on the machine that runs
        the tool. Do not put this on Workers or Vercel: there is no child
        spawn and a public URL would be a get_secret service.
      </Text>

      <Table
        headers={["Plane", "Lives where", "Does", "Must not"]}
        rows={[
          [
            "Control",
            "Private vault host per env",
            "Store, request_grant, operator approve, revoke, audit",
            "Decrypt, return values, bind publicly without Access + auth",
          ],
          [
            "Agent MCP",
            "Stdio on the agent runner",
            "list names, request pending grants, list own grant status",
            "Approve, revoke others, read values, carry VAULT_MASTER_KEY in mcp.json",
          ],
          [
            "Inject",
            "Same host as the tool process",
            "vault run after an active grant; plaintext only in child env",
            "HTTP inject endpoint, shared staging/prod sqlite, inherit the operator’s whole env",
          ],
        ]}
        striped
      />

      <Grid columns={2} gap={16}>
        <Card>
          <CardHeader trailing={<Pill size="sm" active>staging</Pill>}>
            agent-vault-staging
          </CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text>Own VM or container. Own VAULT_HOME. Own master key. Own sqlite.</Text>
              <Text>Secrets: sk_test / sandbox / fixtures only. Never a live key.</Text>
              <Text>Operator console behind Cloudflare Access after auth exists. Loopback + tunnel, not 0.0.0.0.</Text>
              <Text>MCP stdio on the staging agent runner with VAULT_HOME only.</Text>
              <Text>Session grants OK for iteration. Default port 8788+.</Text>
            </Stack>
          </CardBody>
        </Card>
        <Card>
          <CardHeader trailing={<Pill size="sm" active>production</Pill>}>
            agent-vault-prod
          </CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text>Second instance. Different key. Different disk. No restore-from-staging.</Text>
              <Text>Live keys only. Prefer --once. Short session TTL. Human approve on every new (secret, agent, tool).</Text>
              <Text>Access + mTLS or Unix socket. No HTTP MCP. Audit shipped off-box (append-only).</Text>
              <Text>Encrypted volume. Backups encrypted with a second key. master.key never in git or Cursor config.</Text>
              <Text>On-call: treat key + sqlite as a single-user KMS. Rotation is “write a new secret name,” not re-encrypt-in-place (unset does not exist).</Text>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <H3>Environment matrix</H3>
      <Table
        headers={["Item", "Staging", "Production", "Never share"]}
        rows={[
          ["Master key", "Generated for staging only", "Generated for prod only", "Yes"],
          ["SQLite file", "staging volume", "prod volume", "Yes"],
          ["Secret values", "test / sandbox", "live", "Yes"],
          ["Operator Access app", "vault-staging", "vault-prod", "Yes"],
          ["Agent runners", "staging agents only", "prod agents only", "Yes"],
          ["Grant default", "session OK", "once", "Policy, not a file"],
          ["HTTP MCP", "off or auth’d", "off", "—"],
          ["CI / dest auto-deploy", "tests only; no public URL", "promote after staging green", "Do not attach this repo to a web auto-deploy"],
        ]}
        striped
      />

      <H2>What you must build before either env</H2>
      <TodoList todos={hardenTodos} />

      <Callout tone="warning" title="Inject cannot move to the cloud without changing the product">
        vault run is the only decrypt. If staging agents run on one host and
        the vault on another, you need a privileged runner on the agent host
        that already holds the key — or you invent an HTTP inject, which DAV-42
        calls a failed product. Plan two colocated processes per environment,
        not one central API.
      </Callout>

      <H2>What not to stand up</H2>
      <Grid columns="1fr 1fr" gap={16}>
        <Stack gap={8}>
          <H3>Wrong hosts</H3>
          <Text>Cloudflare Worker / Durable Object (no spawn, wrong persistence).</Text>
          <Text>Vercel / any public URL (unauthenticated grant + store today; get_secret tomorrow).</Text>
          <Text>Docker with published 8787/tcp.</Text>
          <Text>One vault used by both staging and production agents.</Text>
        </Stack>
        <Stack gap={8}>
          <H3>Wrong key handling</H3>
          <Text>VAULT_MASTER_KEY in mcp.json, shell history, or dest deploy env that agents can read.</Text>
          <Text>Copying master.key or vault.sqlite from staging to prod “to save time.”</Text>
          <Text>Committing .env. Checking sqlite into backups that leave the box unencrypted.</Text>
        </Stack>
      </Grid>

      <Divider />

      <H2>Honest scope vs DAV-42</H2>
      <Text>
        The ticket wants the full loop: one vault, many agents, in-chat grant,
        connector inject, revoke + audit. This SHA has store, MCP request,
        operator grant, local inject, revoke, audit. It does not have in-chat
        approval UX, a connector runtime that wraps existing MCP tools, multi-
        operator identity, or a deployable control plane. Shipping staging
        now would be “put an unauthenticated grant approver on a box.” Ship
        the hardening list first, then two isolated hosts, then wrap tools
        with vault run.
      </Text>
      <Text tone="tertiary" size="small">
        Security review of /Users/naffis/projects/agent-vault dest vs main.
        Isolation tests on the merged PR were green. No production host should
        run this commit.
      </Text>
    </Stack>
  );
}
