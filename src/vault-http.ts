/**
 * Local `http_request` (3.8): resolve an item by name or host, require an active grant for
 * (item, agent, tool), decrypt in-process, and hand the value to the shared hosted connector.
 * Pure over a `LocalHttpHost` so `Vault` keeps its private state; the result never carries the
 * value, and the connector redacts every encoding of it from the origin body.
 */
import type { LocalItemMeta } from "./db.ts";
import { LOCAL_DEFAULT_INJECT } from "./db.ts";
import { executeConnector, type ConnectorFetch, type ConnectorResult } from "./hosted/connector.ts";
import { HttpError } from "./hosted/errors.ts";
import { assertAllowedHostname } from "./hosted/ssrf.ts";
import { normalizeActorId, normalizeSecretName, suggestedNameFromHost } from "./ids.ts";
import { assertSafePublicObject } from "./redact.ts";
import type { AuditAction, GrantRecord, GrantScope } from "./types.ts";

/** The grant "tool" a local MCP `http_request` call is keyed on: `vault grant --tool http_request`. */
export const HTTP_REQUEST_TOOL = "http_request";

export type LocalHttpInput = {
  agentId: string;
  toolId?: string;
  itemName?: string;
  host?: string;
  method: string;
  path: string;
  body?: unknown;
  contentType?: string;
  taskDescription?: string;
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
};

/** Public grant shape shared by local MCP results; mirrors the hosted field names. */
export type LocalGrantPublic = {
  grant_id: string;
  policy: "prompt" | "session";
  status: string;
  environment_id: "local";
  item_name: string;
  agent_id: string;
  tool_id: string;
  expires_at: string | null;
  created_at: string;
  approved_at: string | null;
  consumed_at: string | null;
};

export type LocalItemSummary = { name: string; last4: string; allowed_hosts: string[]; inject: string };

export type LocalHttpResult =
  | { status: "need_item"; suggested_name: string; host: string; message: string }
  | { status: "ambiguous"; items: LocalItemSummary[]; truncated: boolean }
  | (LocalGrantPublic & { message: string })
  | { status: number; body: string; item_name: string; host: string };

/** What `localHttpRequest` needs from the vault; the vault supplies its private db, key, and audit. */
export type LocalHttpHost = {
  getItem(name: string): LocalItemMeta | undefined;
  findItemsByHost(host: string): LocalItemMeta[];
  /** Newest pending or active grant for the triple, with expiry already settled. */
  openGrant(secretName: string, agentId: string, toolId: string): GrantRecord | undefined;
  requestGrant(input: { secretName: string; agentId: string; toolId: string; scope?: GrantScope; actor?: string }): GrantRecord;
  setGrantStatus(id: string, status: GrantRecord["status"], revokedAt: string | null): void;
  decrypt(name: string): string;
  audit(action: AuditAction, parts: { secretName?: string; agentId?: string; toolId?: string; actor?: string }): void;
  now(): string;
};

/** `bearer`, `basic`, or `header:<Name>`. Unknown modes are refused rather than silently Bearer. */
export function normalizeInject(raw: string | undefined): string {
  const value = (raw ?? LOCAL_DEFAULT_INJECT).trim();
  if (value === "bearer" || value === "basic") return value;
  if (value.startsWith("header:") && /^header:[A-Za-z0-9-]+$/.test(value)) return value;
  throw new Error("inject must be bearer, basic, or header:<Name>");
}

export function normalizeAllowedHosts(hosts: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of hosts ?? []) {
    const host = raw.trim().toLowerCase();
    if (!host) continue;
    assertAllowedHostname(host, [host]);
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

export function publicLocalGrant(grant: GrantRecord): LocalGrantPublic {
  return {
    grant_id: grant.id,
    policy: grant.scope === "session" ? "session" : "prompt",
    status: grant.status,
    environment_id: "local",
    item_name: grant.secretName,
    agent_id: grant.agentId,
    tool_id: grant.toolId,
    expires_at: grant.expiresAt,
    created_at: grant.createdAt,
    approved_at: grant.approvedAt,
    consumed_at: grant.status === "consumed" ? grant.revokedAt : null,
  };
}

export function itemSummary(m: LocalItemMeta): LocalItemSummary {
  return { name: m.name, last4: m.last4, allowed_hosts: m.allowedHosts, inject: m.inject };
}

export function approveHint(grant: GrantRecord): string {
  return `Waiting for the operator. Approve with: vault grant --secret ${grant.secretName} --agent ${grant.agentId} --tool ${grant.toolId} --once (or --session), or in the local console.`;
}

export function needItemResult(itemName: string | undefined, host: string | undefined): LocalHttpResult {
  const suggested = itemName ? normalizeSecretName(itemName) : (host && suggestedNameFromHost(host)) || "API_KEY";
  const where = host ? ` --host ${host}` : "";
  return {
    status: "need_item",
    suggested_name: suggested,
    host: host ?? "",
    message: `No credential${itemName ? ` named ${suggested}` : host ? ` is allowed for ${host}` : ""}. Store it with: vault set ${suggested}${where}. Do not paste the secret into chat.`,
  };
}

function resolveItem(host: LocalHttpHost, input: LocalHttpInput, hostname: string | undefined): LocalItemMeta | LocalHttpResult {
  if (input.itemName) {
    return host.getItem(input.itemName) ?? needItemResult(input.itemName, hostname);
  }
  if (!hostname) throw new Error("http_request requires item_name or host");
  const matches = host.findItemsByHost(hostname);
  if (matches.length > 1) {
    return { status: "ambiguous", items: matches.slice(0, 5).map(itemSummary), truncated: matches.length > 5 };
  }
  return matches[0] ?? needItemResult(undefined, hostname);
}

function isItem(v: LocalItemMeta | LocalHttpResult): v is LocalItemMeta {
  return "allowedHosts" in v;
}

export async function localHttpRequest(host: LocalHttpHost, input: LocalHttpInput): Promise<LocalHttpResult> {
  const agentId = normalizeActorId(input.agentId, "agent");
  const toolId = normalizeActorId(input.toolId ?? HTTP_REQUEST_TOOL, "tool");
  const hostname = input.host?.trim().toLowerCase();
  const resolved = resolveItem(host, input, hostname);
  if (!isItem(resolved)) return resolved;
  const item = resolved;
  const parts = { secretName: item.name, agentId, toolId };
  if (hostname && !item.allowedHosts.includes(hostname)) {
    host.audit("inject_denied", parts);
    throw new HttpError(400, `host_mismatch: ${hostname} is not in allowed_hosts`, {
      status: "host_mismatch",
      host: hostname,
      allowed_hosts: item.allowedHosts,
    });
  }
  const grant = host.openGrant(item.name, agentId, toolId);
  if (!grant || grant.status !== "active") {
    host.audit("inject_denied", parts);
    const pending = grant ?? host.requestGrant({ ...parts, actor: agentId });
    return { ...publicLocalGrant(pending), message: approveHint(pending) };
  }
  const once = grant.scope === "once";
  if (once) host.setGrantStatus(grant.id, "consumed", host.now());
  const secret = host.decrypt(item.name);
  let origin: ConnectorResult;
  try {
    origin = await executeConnector(
      { secret, username: null, last4: item.last4, inject: item.inject, allowedHosts: item.allowedHosts, name: item.name, kind: "secret" },
      { method: input.method, path: input.path, host: hostname, body: input.body, contentType: input.contentType },
      { fetchImpl: input.fetchImpl, resolveAddresses: input.resolveAddresses },
    );
  } catch (err) {
    if (once) host.setGrantStatus(grant.id, "active", null);
    // 400-class connector errors (host mismatch, blocked address) stop the send before the value leaves.
    const denied = err instanceof HttpError && err.status === 400;
    host.audit(denied ? "inject_denied" : "inject", { ...parts, actor: agentId });
    throw err;
  }
  host.audit("inject", { ...parts, actor: agentId });
  // Like hosted prompt grants: a failed origin call does not spend the approval.
  if (once && (origin.status < 200 || origin.status >= 300)) host.setGrantStatus(grant.id, "active", null);
  const result = { status: origin.status, body: origin.body, item_name: item.name, host: hostname ?? item.allowedHosts[0] ?? "" };
  assertSafePublicObject("httpRequest", result);
  return result;
}
