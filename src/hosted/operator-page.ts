import { PRODUCT_NAME } from "../brand.ts";

export function hostedOperatorHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${PRODUCT_NAME}</title>
  <style>
    :root { color-scheme: dark; --bg:#111; --fg:#eee; --muted:#9aa; --line:#333; }
    html, body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 ui-sans-serif, system-ui, sans-serif; }
    main { max-width: 920px; margin: 0 auto; padding: 24px 16px 64px; }
    h1 { font-size: 1.35rem; }
    p { color: var(--muted); }
    .banner { border: 1px solid var(--line); padding: 12px 14px; margin: 16px 0 24px; }
    label { display:block; margin: 10px 0 4px; color: var(--muted); font-size: 13px; }
    input, select, button { font: inherit; }
    input, select { width: 100%; box-sizing: border-box; background:#1a1a1a; color:var(--fg); border:1px solid var(--line); padding:8px; }
    button { background:#244024; color:var(--fg); border:1px solid #3a5; padding:8px 12px; cursor:pointer; }
    pre { white-space: pre-wrap; word-break: break-all; background:#1a1a1a; padding:8px; border:1px solid var(--line); }
    #flash { min-height: 1.4em; }
  </style>
</head>
<body>
  <main>
    <h1>${PRODUCT_NAME}</h1>
    <p>Store named credentials once. Agents request use. You authorize. The runtime gets the value. The model never does.</p>
    <div class="banner">Paste your operator token to use this console. Issue a Grok Bot token once. MCP never sees secret values.</div>
    <form id="signin">
      <label>Operator token <input name="token" type="password" autocomplete="off" /></label>
      <button type="submit">Use token</button>
    </form>
    <p id="flash"></p>
    <h2>Grok Bot</h2>
    <p>MCP URL: <code id="mcp_url"></code></p>
    <form id="grok">
      <label>Client name <input name="name" value="grok" /></label>
      <button type="submit">Issue Grok Bot token</button>
    </form>
    <pre id="grok_once"></pre>
    <h2>Store item</h2>
    <form id="store">
      <label>Name <input name="name" required placeholder="SPOTIFY_TOKEN" /></label>
      <label>Kind
        <select name="kind"><option value="secret">secret</option><option value="login">login</option></select>
      </label>
      <label>Environment
        <select name="environment"><option value="staging">staging</option><option value="production">production</option></select>
      </label>
      <label>Value <input name="value" type="password" autocomplete="off" /></label>
      <label>Username (login) <input name="username" /></label>
      <label>Allowed hosts (comma) <input name="allowed_hosts" placeholder="api.spotify.com" /></label>
      <label>Inject <input name="inject" value="bearer" /></label>
      <button type="submit">Store</button>
    </form>
    <h2>Items</h2>
    <div id="items"></div>
    <h2>Rotate</h2>
    <form id="rotate">
      <label>Item id <input name="id" /></label>
      <label>New value <input name="value" type="password" autocomplete="off" /></label>
      <button type="submit">Rotate</button>
    </form>
    <h2>Inbox</h2>
    <div id="inbox"></div>
    <h2>Approve by code</h2>
    <form id="code">
      <label>8-digit code <input name="code" maxlength="8" /></label>
      <button type="submit">Approve</button>
    </form>
  </main>
  <script>
    const KEY = "vault_op_token";
    const flash = (m) => { document.getElementById("flash").textContent = m; };
    const opToken = () => sessionStorage.getItem(KEY) || "";
    const headers = () => {
      const h = { "content-type": "application/json" };
      if (opToken()) h.Authorization = "Bearer " + opToken();
      return h;
    };
    document.getElementById("mcp_url").textContent = location.origin + "/mcp";
    document.getElementById("signin").onsubmit = (e) => {
      e.preventDefault();
      sessionStorage.setItem(KEY, e.target.token.value.trim());
      e.target.token.value = "";
      flash("Token saved in this tab");
      loadInbox();
      loadItems();
    };
    async function loadInbox() {
      const r = await fetch("/api/inbox", { headers: headers() });
      const j = await r.json();
      const el = document.getElementById("inbox");
      el.innerHTML = "";
      for (const g of j.grants || []) {
        const row = document.createElement("div");
        row.textContent = g.id + " " + g.status + " " + (g.task_description || "");
        const b = document.createElement("button");
        b.textContent = "Approve prompt";
        b.onclick = async () => {
          await fetch("/api/grants/" + g.id + "/approve", {
            method: "POST", headers: headers(), body: JSON.stringify({ policy: "prompt" })
          });
          loadInbox();
        };
        row.appendChild(b);
        el.appendChild(row);
      }
    }
    async function loadItems() {
      const el = document.getElementById("items");
      el.innerHTML = "";
      for (const environment of ["staging", "production"]) {
        const r = await fetch("/api/items?environment=" + environment, { headers: headers() });
        const j = await r.json();
        for (const i of j.items || []) {
          const row = document.createElement("div");
          row.textContent = environment + " " + i.name + " " + i.kind + " ••••" + i.last4 + " " + (i.username || "");
          const del = document.createElement("button");
          del.textContent = "Delete";
          del.onclick = async () => {
            await fetch("/api/items/" + i.id, { method: "DELETE", headers: headers() });
            loadItems();
          };
          row.appendChild(del);
          el.appendChild(row);
        }
      }
    }
    document.getElementById("store").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const hosts = f.allowed_hosts.value.split(",").map((s) => s.trim()).filter(Boolean);
      const body = {
        name: f.name.value, kind: f.kind.value, environment: f.environment.value,
        value: f.value.value, username: f.username.value || undefined,
        allowed_hosts: hosts, inject: f.inject.value
      };
      const r = await fetch("/api/items", { method: "POST", headers: headers(), body: JSON.stringify(body) });
      f.value.value = "";
      flash(r.ok ? "Stored" : "Store failed");
      loadItems();
    };
    document.getElementById("rotate").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const r = await fetch("/api/items/" + f.id.value + "/rotate", {
        method: "POST", headers: headers(), body: JSON.stringify({ value: f.value.value })
      });
      f.value.value = "";
      flash(r.ok ? "Rotated" : "Rotate failed");
      loadItems();
    };
    document.getElementById("code").onsubmit = async (e) => {
      e.preventDefault();
      const code = e.target.code.value;
      const r = await fetch("/api/grants/approve-by-code", { method: "POST", headers: headers(), body: JSON.stringify({ code }) });
      flash(r.ok ? "Approved" : "Code rejected");
      loadInbox();
    };
    document.getElementById("grok").onsubmit = async (e) => {
      e.preventDefault();
      const name = e.target.name.value || "grok";
      const r = await fetch("/api/clients/model", {
        method: "POST", headers: headers(),
        body: JSON.stringify({ name: name, environment: "staging" })
      });
      const j = await r.json();
      const box = document.getElementById("grok_once");
      if (!r.ok || !j.token) { flash("Could not issue Grok token"); box.textContent = ""; return; }
      box.textContent = "Shown once. Grok Bot connector Authorization:\\nBearer " + j.token;
      flash("Grok token issued. Copy it now.");
    };
    loadInbox();
    loadItems();
  </script>
</body>
</html>`;
}
