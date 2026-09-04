import { PRODUCT_NAME } from "./brand.ts";

/**
 * Local loopback console for `vault serve`. Shares the hosted vocabulary (credentials, agents,
 * approvals, activity) and never puts server data through `innerHTML`: rows are built with
 * `createElement` and `textContent`, so a hostile credential name or agent id renders as text.
 * Still a small single page by design; the hosted console is the full product.
 */
export function operatorHtml(nonce = ""): string {
  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${PRODUCT_NAME} local console</title>
  <style${nonceAttr}>
    :root { color-scheme: dark; --bg:#111; --fg:#eee; --muted:#9aa; --line:#333; --ok:#8fd19e; --warn:#e6c07b; }
    html, body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 ui-sans-serif, system-ui, sans-serif; }
    main { max-width: 920px; margin: 0 auto; padding: 24px 16px 64px; }
    h1 { font-size: 1.35rem; margin: 0 0 8px; }
    h2 { font-size: 1rem; margin: 28px 0 8px; }
    p, li { color: var(--muted); }
    code { color: var(--fg); }
    .banner { border: 1px solid var(--line); padding: 12px 14px; margin: 16px 0 24px; }
    form, table { width: 100%; }
    label { display:block; margin: 10px 0 4px; color: var(--muted); font-size: 13px; }
    input, select, button { font: inherit; }
    input, select { width: 100%; box-sizing: border-box; background:#1a1a1a; color:var(--fg); border:1px solid var(--line); padding:8px; }
    button { background:#2a2a2a; color:var(--fg); border:1px solid var(--line); padding:8px 12px; cursor:pointer; }
    button.primary { background:#244024; border-color:#3a5; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    table { border-collapse: collapse; margin-top: 8px; }
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:8px 6px; font-size:13px; overflow-wrap: anywhere; }
    th { color: var(--muted); font-weight: 600; }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .actions button { margin-right: 6px; }
    #flash { min-height: 1.4em; margin: 8px 0; }
  </style>
</head>
<body>
  <main>
    <h1>${PRODUCT_NAME} local console</h1>
    <p>Named credentials for agents and tools. Values are stored encrypted and attached by <code>http_request</code> or injected by <code>vault run</code>. They are never shown here after submit, and never returned to the model.</p>
    <div class="banner">
      This is not a human password manager. No autofill, TOTP, passkeys, or sharing secrets with other people.
      Chat and this console show <strong>name, last four, and approval metadata</strong> only.
    </div>
    <p id="flash" role="status"></p>

    <h2>Operator token</h2>
    <form id="token-form" novalidate>
      <label for="loopback-token">Operator bearer printed by vault serve (the model bearer does not open this console)</label>
      <input id="loopback-token" name="token" type="password" autocomplete="off" />
      <p><button type="submit">Save token</button></p>
    </form>

    <h2>Store a credential</h2>
    <form id="store" novalidate>
      <div class="row">
        <div>
          <label for="name">Name</label>
          <input id="name" name="name" placeholder="STRIPE_KEY" autocomplete="off" />
        </div>
        <div>
          <label for="value">Value (cleared after submit)</label>
          <input id="value" name="value" type="password" autocomplete="new-password" />
        </div>
        <div>
          <label for="hosts">Allowed hosts (comma separated; only these hosts ever receive this credential)</label>
          <input id="hosts" name="hosts" placeholder="api.stripe.com" autocomplete="off" />
        </div>
        <div>
          <label for="inject">Inject</label>
          <select id="inject" name="inject">
            <option value="bearer">Authorization: Bearer</option>
            <option value="basic">HTTP Basic</option>
            <option value="header:X-API-Key">Header X-API-Key</option>
          </select>
        </div>
        <div>
          <label for="username">Username (HTTP Basic user; optional)</label>
          <input id="username" name="username" placeholder="svc" autocomplete="off" />
        </div>
      </div>
      <p><button class="primary" type="submit">Store encrypted</button></p>
    </form>

    <h2>Credentials</h2>
    <table>
      <thead><tr><th scope="col">Name</th><th scope="col">Last four</th><th scope="col">Hosts</th><th scope="col">Inject</th><th scope="col">Updated</th></tr></thead>
      <tbody id="secrets"></tbody>
    </table>

    <h2>Approve a request</h2>
    <p>MCP <code>http_request</code> approvals use tool <code>http_request</code>; the agent is the MCP client's name.</p>
    <form id="grant" novalidate>
      <div class="row">
        <div>
          <label for="g-secret">Credential</label>
          <input id="g-secret" name="secretName" placeholder="STRIPE_KEY" autocomplete="off" />
        </div>
        <div>
          <label for="g-agent">Agent</label>
          <input id="g-agent" name="agentId" placeholder="cursor" autocomplete="off" />
        </div>
        <div>
          <label for="g-tool">Tool</label>
          <input id="g-tool" name="toolId" placeholder="http_request" autocomplete="off" />
        </div>
        <div>
          <label for="g-scope">Approval</label>
          <select id="g-scope" name="scope">
            <option value="once">once</option>
            <option value="session">session</option>
          </select>
        </div>
      </div>
      <p><button class="primary" type="submit">Approve</button></p>
    </form>

    <h2>Approvals</h2>
    <table>
      <thead><tr><th scope="col">Credential</th><th scope="col">Agent</th><th scope="col">Tool</th><th scope="col">Approval</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
      <tbody id="grants"></tbody>
    </table>

    <h2>Activity</h2>
    <p>Who, which credential name, which tool and agent, when, approve or revoke. The value is never stored here.</p>
    <table>
      <thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Actor</th><th scope="col">Credential</th><th scope="col">Agent</th><th scope="col">Tool</th></tr></thead>
      <tbody id="audit"></tbody>
    </table>
  </main>
  <script${nonceAttr}>
    const flash = (msg, ok) => {
      const el = document.getElementById("flash");
      el.textContent = msg;
      el.className = ok ? "ok" : "warn";
    };
    const TOKEN_KEY = "botpasses-loopback";
    const tokenHdr = () => {
      const t = sessionStorage.getItem(TOKEN_KEY) || "";
      return t ? { authorization: "Bearer " + t } : {};
    };
    const j = (path, opts = {}) => fetch(path, {
      ...opts,
      headers: Object.assign({}, opts.headers || {}, tokenHdr()),
    }).then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || r.statusText);
      return body;
    });
    // Every server value goes through textContent; rows are built as DOM nodes, never as markup strings.
    const cell = (value) => {
      const td = document.createElement("td");
      td.textContent = value == null ? "" : String(value);
      return td;
    };
    const rowOf = (cells) => {
      const tr = document.createElement("tr");
      for (const c of cells) tr.appendChild(c);
      return tr;
    };
    const fill = (id, rows, emptyCols) => {
      const body = document.getElementById(id);
      body.replaceChildren();
      if (!rows.length) {
        const td = cell("None yet");
        td.colSpan = emptyCols;
        body.appendChild(rowOf([td]));
        return;
      }
      for (const r of rows) body.appendChild(r);
    };
    async function refresh() {
      const [items, grants, audit] = await Promise.all([
        j("/api/items"),
        j("/api/grants"),
        j("/api/audit"),
      ]);
      fill("secrets", items.items.map((s) => rowOf([
        cell(s.name), cell(s.last4), cell((s.allowedHosts || []).join(", ")), cell(s.inject), cell(s.updatedAt),
      ])), 5);
      fill("grants", grants.grants.map((g) => {
        const actions = document.createElement("td");
        actions.className = "actions";
        if (g.status === "pending" || g.status === "active") {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.dataset.revoke = g.id;
          btn.textContent = g.status === "pending" ? "Deny" : "Revoke";
          actions.appendChild(btn);
        }
        return rowOf([cell(g.secretName), cell(g.agentId), cell(g.toolId), cell(g.scope), cell(g.status), actions]);
      }), 6);
      fill("audit", audit.audit.map((a) => rowOf([
        cell(a.createdAt), cell(a.action), cell(a.actor), cell(a.secretName), cell(a.agentId), cell(a.toolId),
      ])), 6);
    }
    document.getElementById("store").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("name").value.trim();
      const value = document.getElementById("value").value;
      const hosts = document.getElementById("hosts").value.split(",").map((h) => h.trim()).filter(Boolean);
      const inject = document.getElementById("inject").value;
      const username = document.getElementById("username").value.trim();
      if (!name || !value) { flash("Name and value are required", false); return; }
      if (inject === "basic" && !username) { flash("HTTP Basic needs a username", false); return; }
      document.getElementById("value").value = "";
      try {
        const res = await j("/api/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, value, allowed_hosts: hosts, inject, ...(username ? { username } : {}) }),
        });
        flash("Stored " + res.item.name + " ending " + res.item.last4 + " (value not shown again)", true);
        await refresh();
      } catch (err) { flash(err.message, false); }
    });
    document.getElementById("grant").addEventListener("submit", async (e) => {
      e.preventDefault();
      const secretName = document.getElementById("g-secret").value.trim();
      const agentId = document.getElementById("g-agent").value.trim();
      const toolId = document.getElementById("g-tool").value.trim() || "http_request";
      if (!secretName || !agentId) {
        flash("Credential and agent are required to approve", false);
        return;
      }
      try {
        const res = await j("/api/grants", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            secretName,
            agentId,
            toolId,
            scope: document.getElementById("g-scope").value,
          }),
        });
        flash("Approval " + res.grant.status + " for " + res.grant.secretName + " to " + res.grant.toolId + " (value not shown)", true);
        await refresh();
      } catch (err) { flash(err.message, false); }
    });
    document.getElementById("grants").addEventListener("click", async (e) => {
      const id = e.target instanceof HTMLElement ? e.target.dataset.revoke : undefined;
      if (!id) return;
      try {
        await j("/api/grants/" + encodeURIComponent(id) + "/revoke", { method: "POST" });
        flash("Revoked " + id, true);
        await refresh();
      } catch (err) { flash(err.message, false); }
    });
    document.getElementById("token-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const next = document.getElementById("loopback-token").value.trim();
      if (!next) { flash("Paste the operator bearer printed by vault serve", false); return; }
      sessionStorage.setItem(TOKEN_KEY, next);
      document.getElementById("loopback-token").value = "";
      flash("Token saved", true);
      refresh().catch((err) => flash(err.message, false));
    });
    if (sessionStorage.getItem(TOKEN_KEY)) {
      refresh().catch((err) => flash(err.message, false));
    } else {
      flash("Paste the operator bearer printed by vault serve", false);
    }
  </script>
</body>
</html>`;
}
