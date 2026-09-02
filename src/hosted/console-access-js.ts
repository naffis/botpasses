export const CONSOLE_ACCESS_JS = `
function formatWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}
function accessFilter() {
  const parts = (location.hash || "").replace(/^#/, "").split("/");
  if (parts[0] !== "access") return { clientId: "", itemName: "" };
  return {
    clientId: parts[1] === "client" ? decodeURIComponent(parts[2] || "") : "",
    itemName: parts[1] === "item"
      ? decodeURIComponent(parts[2] || "")
      : (parts[3] === "item" ? decodeURIComponent(parts[4] || "") : "")
  };
}
function accessMetaLine(label, value) {
  if (!value) return "";
  return label + " " + value;
}
function accessRow(titleParts, metaLines, actions) {
  const row = document.createElement("div");
  row.className = "access-row";
  const main = document.createElement("div");
  main.className = "access-row-main";
  const title = document.createElement("p");
  title.className = "access-row-title";
  title.textContent = titleParts.filter(Boolean).join(" · ");
  main.appendChild(title);
  const lines = metaLines.filter(Boolean);
  if (lines.length) {
    const meta = document.createElement("p");
    meta.className = "access-meta";
    meta.textContent = lines.join(" · ");
    main.appendChild(meta);
  }
  row.appendChild(main);
  if (actions) row.appendChild(actions);
  return row;
}
function accessActions() {
  const wrap = document.createElement("div");
  wrap.className = "access-row-actions";
  for (let i = 0; i < arguments.length; i++) {
    if (arguments[i]) wrap.appendChild(arguments[i]);
  }
  return wrap.childNodes.length ? wrap : null;
}
function revokeBtn(kind, id) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn-danger";
  b.textContent = "Revoke";
  b.addEventListener("click", function() { openConfirm(kind, id); });
  return b;
}
function rotateClientBtn(id) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn-ghost";
  b.textContent = "Rotate";
  b.addEventListener("click", function() { openConfirm("client-rotate", id); });
  return b;
}
function tokenHint(last4) {
  if (!last4) return "";
  return "Token ••••" + last4;
}
function activityLink(href, label) {
  const a = document.createElement("a");
  a.href = href;
  a.className = "access-log-link";
  a.dataset.testid = "access-log-link";
  a.textContent = label || "Audit log";
  a.addEventListener("click", function(e) {
    e.preventDefault();
    history.replaceState(null, "", href);
    loadAccess();
    const log = document.getElementById("access-audit");
    if (log && log.scrollIntoView) log.scrollIntoView({ block: "start" });
  });
  return a;
}
function listEmpty(el, message) {
  if (!el) return;
  el.innerHTML = "";
  const p = document.createElement("p");
  p.className = "section-empty hint";
  p.textContent = message;
  el.appendChild(p);
}
function fetchedLine(fetched) {
  if (!fetched || !fetched.length) return "";
  return "Fetched " + fetched.join(", ");
}
async function loadAccess() {
  const panel = document.getElementById("access-panel");
  const err = document.getElementById("access-error");
  if (!panel) return;
  setHidden("access-error", true);
  const snap = await api("/api/access");
  const data = await snap.json().catch(function() { return {}; });
  if (snap.status === 401) { sessionOut(true); return; }
  if (!snap.ok) {
    text(err, data.error || ("Could not load access (" + snap.status + ")"));
    setHidden("access-error", false);
    return;
  }
  const filter = accessFilter();
  let auditUrl = "/api/audit";
  const q = [];
  if (filter.clientId) q.push("client_id=" + encodeURIComponent(filter.clientId));
  if (filter.itemName) q.push("item_name=" + encodeURIComponent(filter.itemName));
  if (q.length) auditUrl += "?" + q.join("&");
  const auditRes = await api(auditUrl);
  const auditBody = await auditRes.json().catch(function() { return {}; });
  if (!auditRes.ok) {
    text(err, auditBody.error || ("Could not load audit (" + auditRes.status + ")"));
    setHidden("access-error", false);
  }
  const clients = data.clients || [];
  const grants = data.grants || [];
  const sessions = data.sessions || [];
  const empty = clients.length === 0 && grants.length === 0 && sessions.filter(function(s) { return !s.current; }).length === 0;
  const emptyEl = document.getElementById("access-empty");
  if (emptyEl) emptyEl.hidden = !empty;
  const cEl = document.getElementById("access-clients");
  const gEl = document.getElementById("access-grants");
  const sEl = document.getElementById("access-sessions");
  const aEl = document.getElementById("access-audit");
  if (cEl) {
    cEl.innerHTML = "";
    if (!clients.length) listEmpty(cEl, "No clients yet. Issue a token above.");
    else for (const c of clients) {
      const href = "#access/client/" + encodeURIComponent(c.id);
      const canRotate = c.status === "active" && c.kind !== "oauth";
      cEl.appendChild(accessRow(
        [c.name, c.kind, c.status, c.environment],
        [
          tokenHint(c.last4),
          accessMetaLine("Created", formatWhen(c.created_at)),
          accessMetaLine("First access", formatWhen(c.first_access_at)),
          accessMetaLine("Last access", formatWhen(c.last_access_at)),
          fetchedLine(c.fetched)
        ],
        accessActions(
          canRotate ? rotateClientBtn(c.id) : null,
          c.status === "active" ? revokeBtn("client", c.id) : null,
          activityLink(href)
        )
      ));
    }
  }
  if (gEl) {
    gEl.innerHTML = "";
    if (!grants.length) listEmpty(gEl, "No grants yet.");
    else for (const g of grants) {
      const live = g.status === "active" || g.status === "pending";
      const href = g.client_id
        ? "#access/client/" + encodeURIComponent(g.client_id) + (g.item_name ? "/item/" + encodeURIComponent(g.item_name) : "")
        : "#access";
      gEl.appendChild(accessRow(
        [g.item_name, g.client_name, g.status],
        [
          accessMetaLine("Created", formatWhen(g.created_at)),
          accessMetaLine("First access", formatWhen(g.first_access_at)),
          accessMetaLine("Last access", formatWhen(g.last_access_at)),
          fetchedLine(g.fetched)
        ],
        accessActions(live ? revokeBtn("grant", g.id) : null, activityLink(href))
      ));
    }
  }
  if (sEl) {
    sEl.innerHTML = "";
    if (!sessions.length) listEmpty(sEl, "No other sessions.");
    else for (const s of sessions) {
      sEl.appendChild(accessRow(
        [s.id, s.current ? "current" : ""],
        [
          accessMetaLine("Created", formatWhen(s.created_at)),
          accessMetaLine("First access", formatWhen(s.first_access_at)),
          accessMetaLine("Last access", formatWhen(s.last_access_at || s.last_seen_at))
        ],
        accessActions(s.current ? null : revokeBtn("session", s.id))
      ));
    }
  }
  if (aEl) {
    aEl.innerHTML = "";
    const rows = auditRes.ok ? (auditBody.audit || []) : [];
    const filtered = filter.itemName
      ? rows.filter(function(e) { return e.itemName === filter.itemName || e.item_name === filter.itemName; })
      : rows;
    const heading = document.getElementById("access-audit-filter");
    if (heading) {
      if (filter.clientId || filter.itemName) {
        heading.hidden = false;
        heading.textContent = filter.itemName
          ? "Showing " + filter.itemName
          : "Showing one client";
      } else {
        heading.hidden = true;
        heading.textContent = "";
      }
    }
    const clear = document.getElementById("access-audit-clear");
    if (clear) clear.hidden = !(filter.clientId || filter.itemName);
    if (!auditRes.ok) listEmpty(aEl, "Could not load audit log.");
    else if (!filtered.length) listEmpty(aEl, "No activity yet.");
    else for (const e of filtered) {
      aEl.appendChild(accessRow(
        [e.action, e.itemName || e.item_name || "", formatWhen(e.at)],
        [],
        null
      ));
    }
  }
}
`;
