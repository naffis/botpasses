/**
 * Console routing on the URL hash. Pure functions so tests can cover the grammar.
 *
 *   #inbox
 *   #credentials                       (aliases: #vault, empty)
 *   #credentials/item/<id>             detail drawer open
 *   #credentials/item/<id>?connect=<provider>&agent=<clientId>&need=<needId>
 *                                      connect dialog for the item, prefilled for that agent (the
 *                                      link an agent's user_connect_required result carries)
 *   #agents                            (aliases: #access, #connect)
 *   #agents/<agents|approvals|sessions|activity>?agent=<id>&credential=<NAME>
 *   #account
 *   #breakglass                        credentials panel with the bootstrap token form shown
 *
 * Legacy `#access/client/<id>/item/<NAME>` maps onto the activity tab filters.
 */

export type Panel = "inbox" | "credentials" | "agents" | "account";
export type AgentsTab = "agents" | "approvals" | "sessions" | "activity";

export type Route = {
  panel: Panel;
  tab: AgentsTab;
  itemId: string;
  agent: string;
  credential: string;
  /** Provider id when the route opens the connect dialog for `itemId`; empty otherwise. */
  connect: string;
  /** The inbox connect need the dialog answers; empty when none. */
  need: string;
  breakglass: boolean;
  query: URLSearchParams;
};

export const AGENTS_TABS: readonly AgentsTab[] = ["agents", "approvals", "sessions", "activity"];

function isTab(v: string): v is AgentsTab {
  return (AGENTS_TABS as readonly string[]).includes(v);
}

function dec(s: string | undefined): string {
  if (!s) return "";
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseRoute(hash: string): Route {
  const bare = (hash || "").replace(/^#/, "");
  const qIndex = bare.indexOf("?");
  const pathPart = qIndex === -1 ? bare : bare.slice(0, qIndex);
  const query = new URLSearchParams(qIndex === -1 ? "" : bare.slice(qIndex + 1));
  const parts = pathPart.split("/").filter(Boolean);
  const head = parts[0] ?? "";
  const route: Route = {
    panel: "credentials",
    tab: "agents",
    itemId: "",
    agent: query.get("agent") ?? "",
    credential: query.get("credential") ?? "",
    connect: query.get("connect") ?? "",
    need: query.get("need") ?? "",
    breakglass: false,
    query,
  };
  if (head === "inbox") route.panel = "inbox";
  else if (head === "account") route.panel = "account";
  else if (head === "breakglass") route.breakglass = true;
  else if (head === "credentials" || head === "vault") {
    if (parts[1] === "item" && parts[2]) route.itemId = dec(parts[2]);
  } else if (head === "agents" || head === "connect") {
    route.panel = "agents";
    if (parts[1] && isTab(parts[1])) route.tab = parts[1];
  } else if (head === "access") {
    route.panel = "agents";
    if (parts[1] && isTab(parts[1])) route.tab = parts[1];
    else if (parts[1] === "client") {
      route.tab = "activity";
      route.agent = dec(parts[2]);
      if (parts[3] === "item") route.credential = dec(parts[4]);
    } else if (parts[1] === "item") {
      route.tab = "activity";
      route.credential = dec(parts[2]);
    }
  }
  return route;
}

export function agentsHash(tab: AgentsTab, filter: { agent?: string; credential?: string } = {}): string {
  const p = new URLSearchParams();
  if (filter.agent) p.set("agent", filter.agent);
  if (filter.credential) p.set("credential", filter.credential);
  const q = p.toString();
  return `#agents/${tab}${q ? `?${q}` : ""}`;
}

export function itemHash(itemId?: string): string {
  return itemId ? `#credentials/item/${encodeURIComponent(itemId)}` : "#credentials";
}

/** The connect deep link for an item: the same shape `connect_url` carries to the agent. */
export function connectHash(itemId: string, connect: { provider: string; agent?: string; need?: string }): string {
  const p = new URLSearchParams({ connect: connect.provider });
  if (connect.agent) p.set("agent", connect.agent);
  if (connect.need) p.set("need", connect.need);
  return `${itemHash(itemId)}?${p.toString()}`;
}

export function routeHash(route: Route): string {
  if (route.breakglass) return "#breakglass";
  if (route.panel === "inbox") return "#inbox";
  if (route.panel === "account") return "#account";
  if (route.panel === "agents") return agentsHash(route.tab, { agent: route.agent, credential: route.credential });
  return itemHash(route.itemId);
}

export const PANEL_COPY: Record<Panel, { title: string; lede: string }> = {
  inbox: {
    title: "Inbox",
    lede: "Requests from your agents. Approve once. The key stays in the vault.",
  },
  credentials: {
    title: "Credentials",
    lede: "Credentials your agents can use. You see the last four characters, not the secret.",
  },
  agents: {
    title: "Agents",
    lede: "Connect an agent, then see who holds a token, what they were approved for, and what happened.",
  },
  account: {
    title: "Account",
    lede: "Your sign-in, authenticator, and backup codes.",
  },
};
