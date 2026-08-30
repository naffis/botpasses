import { PRODUCT_NAME } from "./brand.ts";

export function operatorHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${PRODUCT_NAME}</title>
  <style>
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
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:8px 6px; font-size:13px; }
    th { color: var(--muted); font-weight: 600; }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .actions button { margin-right: 6px; }
    #flash { min-height: 1.4em; margin: 8px 0; }
  </style>
</head>
<body>
  <main>
    <h1>${PRODUCT_NAME}</h1>
    <p>Named secrets for connectors and agents. Values are stored encrypted and injected into a tool process. They are never shown here after submit, and they are never returned to the model.</p>
    <div class="banner">
      This is not a human password manager. No autofill, TOTP, passkeys, or sharing secrets with other people.
      Chat and this console show <strong>name + last-4 / grant metadata</strong> only.
    </div>
    <p id="flash"></p>

    <h2>Store a named secret</h2>
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
      </div>
      <p><button class="primary" type="submit">Store encrypted</button></p>
    </form>

    <h2>Secrets</h2>
    <table>
      <thead><tr><th>Name</th><th>Last-4</th><th>Updated</th></tr></thead>
      <tbody id="secrets"></tbody>
    </table>

    <h2>Approve a grant</h2>
    <form id="grant" novalidate>
      <div class="row">
        <div>
          <label for="g-secret">Secret</label>
          <input id="g-secret" name="secretName" placeholder="STRIPE_KEY" autocomplete="off" />
        </div>
        <div>
          <label for="g-agent">Agent</label>
          <input id="g-agent" name="agentId" placeholder="invoicer" autocomplete="off" />
        </div>
        <div>
          <label for="g-tool">Tool</label>
          <input id="g-tool" name="toolId" placeholder="stripe" autocomplete="off" />
        </div>
        <div>
          <label for="g-scope">Scope</label>
          <select id="g-scope" name="scope">
            <option value="once">once</option>
            <option value="session">session</option>
          </select>
        </div>
      </div>
      <p><button class="primary" type="submit">Approve grant</button></p>
    </form>

    <h2>Grants</h2>
    <table>
      <thead><tr><th>Secret</th><th>Agent</th><th>Tool</th><th>Scope</th><th>Status</th><th></th></tr></thead>
      <tbody id="grants"></tbody>
    </table>

    <h2>Audit</h2>
    <p>Who, which secret name, which tool/agent, when, grant vs revoke. The value is never stored here.</p>
    <table>
      <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Secret</th><th>Agent</th><th>Tool</th></tr></thead>
      <tbody id="audit"></tbody>
    </table>
  </main>
  <script>
    const flash = (msg, ok) => {
      const el = document.getElementById("flash");
      el.textContent = msg;
      el.className = ok ? "ok" : "warn";
    };
    const j = (path, opts) => fetch(path, opts).then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || r.statusText);
      return body;
    });
    async function refresh() {
      const [secrets, grants, audit] = await Promise.all([
        j("/api/secrets"),
        j("/api/grants"),
        j("/api/audit"),
      ]);
      document.getElementById("secrets").innerHTML = secrets.secrets.map((s) =>
        "<tr><td>"+s.name+"</td><td>"+s.last4+"</td><td>"+s.updatedAt+"</td></tr>"
      ).join("") || "<tr><td colspan=3>None yet</td></tr>";
      document.getElementById("grants").innerHTML = grants.grants.map((g) =>
        "<tr><td>"+g.secretName+"</td><td>"+g.agentId+"</td><td>"+g.toolId+"</td><td>"+g.scope+"</td><td>"+g.status+"</td><td class=actions>" +
        (g.status === "pending" || g.status === "active"
          ? "<button data-revoke='"+g.id+"'>Revoke</button>" : "") +
        "</td></tr>"
      ).join("") || "<tr><td colspan=6>None yet</td></tr>";
      document.getElementById("audit").innerHTML = audit.audit.map((a) =>
        "<tr><td>"+a.createdAt+"</td><td>"+a.action+"</td><td>"+a.actor+"</td><td>"+(a.secretName||"")+"</td><td>"+(a.agentId||"")+"</td><td>"+(a.toolId||"")+"</td></tr>"
      ).join("") || "<tr><td colspan=6>None yet</td></tr>";
    }
    document.getElementById("store").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("name").value.trim();
      const value = document.getElementById("value").value;
      if (!name || !value) { flash("Name and value are required", false); return; }
      document.getElementById("value").value = "";
      try {
        const res = await j("/api/secrets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, value }),
        });
        flash("Stored "+res.secret.name+" "+res.secret.last4+" (value not shown again)", true);
        await refresh();
      } catch (err) { flash(err.message, false); }
    });
    document.getElementById("grant").addEventListener("submit", async (e) => {
      e.preventDefault();
      const secretName = document.getElementById("g-secret").value.trim();
      const agentId = document.getElementById("g-agent").value.trim();
      const toolId = document.getElementById("g-tool").value.trim();
      if (!secretName || !agentId || !toolId) {
        flash("Secret, agent, and tool are required to approve a grant", false);
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
        flash("Grant "+res.grant.status+" for "+res.grant.secretName+" → "+res.grant.toolId+" (value not shown)", true);
        await refresh();
      } catch (err) { flash(err.message, false); }
    });
    document.getElementById("grants").addEventListener("click", async (e) => {
      const id = e.target.getAttribute("data-revoke");
      if (!id) return;
      try {
        await j("/api/grants/"+id+"/revoke", { method: "POST" });
        flash("Revoked "+id, true);
        await refresh();
      } catch (err) { flash(err.message, false); }
    });
    refresh().catch((err) => flash(err.message, false));
  </script>
</body>
</html>`;
}
