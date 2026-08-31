import { PRODUCT_NAME } from "../brand.ts";

export function hostedCollectHtml(input: {
  needId: string;
  clientName: string;
  suggestedName: string;
  host: string;
  taskDescription: string | null;
  status: string;
  origin: string;
}): string {
  const pending = input.status === "pending";
  const heading = pending
    ? `${escapeHtml(input.clientName)} needs a credential`
    : "This collect request is no longer pending";
  const form = pending
    ? `
    <form id="fulfill">
      <label>Name <input name="name" required value="${escapeAttr(input.suggestedName)}" placeholder="SPOTIFY_TOKEN" /></label>
      <label>Allowed hosts (comma) <input name="allowed_hosts" required value="${escapeAttr(input.host)}" placeholder="api.spotify.com" /></label>
      <label>Inject
        <select name="inject">
          <option value="bearer" selected>bearer</option>
          <option value="basic">basic</option>
          <option value="header:Authorization">header:Authorization</option>
        </select>
      </label>
      <label>Kind
        <select name="kind"><option value="secret" selected>secret</option><option value="login">login</option></select>
      </label>
      <label>Username (login) <input name="username" /></label>
      <label>Value <input name="value" type="password" autocomplete="off" required /></label>
      <button type="submit">Store and grant</button>
    </form>`
    : "";
  const task = input.taskDescription
    ? `<p>Task: ${escapeHtml(input.taskDescription)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${PRODUCT_NAME} collect</title>
  <style>
    :root { color-scheme: dark; --bg:#111; --fg:#eee; --muted:#9aa; --line:#333; }
    html, body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 ui-sans-serif, system-ui, sans-serif; }
    main { max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; }
    h1 { font-size: 1.25rem; }
    p { color: var(--muted); }
    .client { font-size: 1.05rem; color: var(--fg); border: 1px solid var(--line); padding: 12px 14px; margin: 16px 0; }
    label { display:block; margin: 10px 0 4px; color: var(--muted); font-size: 13px; }
    input, select, button { font: inherit; }
    input, select { width: 100%; box-sizing: border-box; background:#1a1a1a; color:var(--fg); border:1px solid var(--line); padding:8px; }
    button { background:#244024; color:var(--fg); border:1px solid #3a5; padding:8px 12px; cursor:pointer; }
    #flash { min-height: 1.4em; }
  </style>
</head>
<body>
  <main>
    <h1>${PRODUCT_NAME}</h1>
    <p>Confirm the origin is ${escapeHtml(input.origin)} before typing a secret. Never paste it into chat.</p>
    <div class="client">${escapeHtml(heading)}</div>
    ${task}
    <form id="signin">
      <label>Operator token <input name="token" type="password" autocomplete="off" /></label>
      <button type="submit">Use token</button>
    </form>
    <p id="flash"></p>
    ${form}
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
    document.getElementById("signin").onsubmit = (e) => {
      e.preventDefault();
      sessionStorage.setItem(KEY, e.target.token.value.trim());
      e.target.token.value = "";
      flash("Token saved in this tab");
    };
    const fulfill = document.getElementById("fulfill");
    if (fulfill) {
      fulfill.onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const hosts = f.allowed_hosts.value.split(",").map((s) => s.trim()).filter(Boolean);
        const r = await fetch("/api/need-items/${escapeAttr(input.needId)}/fulfill", {
          method: "POST", headers: headers(),
          body: JSON.stringify({
            name: f.name.value, value: f.value.value, allowed_hosts: hosts,
            inject: f.inject.value, kind: f.kind.value,
            username: f.username.value || undefined
          })
        });
        const data = await r.json().catch(() => ({}));
        f.value.value = "";
        flash(r.ok ? "Stored. The agent can find this item now." : (data.error || "Store failed"));
      };
    }
  </script>
</body>
</html>`;
}

export function hostedCollectMissingHtml(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>${PRODUCT_NAME}</title></head>
<body><p>Unknown collect request.</p></body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
