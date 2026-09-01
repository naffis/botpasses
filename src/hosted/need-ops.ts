import { randomUUID } from "node:crypto";
import { encrypt } from "../crypto.ts";
import { last4, normalizeSecretName, suggestedNameFromHost } from "../ids.ts";
import { assertSafePublicObject } from "../redact.ts";
import type {
  ClientRecord,
  FindItemsResult,
  HostedGrantRecord,
  ItemKind,
  ItemPublic,
  ItemRecord,
  NeedPublic,
  PolicyRecord,
  VaultEnvName,
} from "../hosted-types.ts";
import type { VaultStore } from "../store/types.ts";
import { StoreConflictError } from "../store/conflict.ts";
import { HttpError, NeedItemError, type NeedItemPayload } from "./errors.ts";
import { matchFindItems, NEED_ITEM_MESSAGE } from "./need-match.ts";
import type { OrgRateLimiter } from "./rate-limit.ts";
import { assertAllowedHostname } from "./ssrf.ts";

const TASK_DESC_MAX = 500;

export type NeedHost = {
  store: VaultStore;
  limiter: OrgRateLimiter;
  publicUrl: string;
  now: () => Date;
  magicTtlMs: number;
  maxItemBytes: number;
  envFor: (orgId: string, name: VaultEnvName) => Promise<{ id: string; name: VaultEnvName }>;
  dekForOrg: (orgId: string) => Promise<Buffer>;
  clientInOrg: (orgId: string, clientId: string) => Promise<ClientRecord>;
  assertHosts: (hosts: string[]) => void;
  assertPlane: (name: VaultEnvName) => void;
  standingFor: (
    orgId: string,
    clientId: string,
    item: { id: string; folderId: string | null; environmentId: string },
  ) => Promise<PolicyRecord | undefined>;
  publicItem: (environment: VaultEnvName, item: ItemRecord) => ItemPublic;
  audit: (
    orgId: string,
    action: string,
    actor: string,
    itemName: string | null,
    clientId: string | null,
  ) => Promise<void>;
};

function nowIso(d: Date): string {
  return d.toISOString();
}

function truncateTask(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  return t.length > TASK_DESC_MAX ? t.slice(0, TASK_DESC_MAX) : t;
}

function collectUrl(host: NeedHost, needId: string): string {
  return `${host.publicUrl.replace(/\/$/, "")}/collect/${needId}`;
}

function needPayload(
  host: NeedHost,
  needId: string,
  suggestedName: string,
  itemHost: string,
  clientName: string,
): NeedItemPayload {
  const payload: NeedItemPayload = {
    status: "need_item",
    collect_url: collectUrl(host, needId),
    suggested_name: suggestedName,
    host: itemHost,
    client_name: clientName,
    need_id: needId,
    message: NEED_ITEM_MESSAGE,
  };
  assertSafePublicObject("needItem", payload);
  return payload;
}

export async function findItems(
  host: NeedHost,
  input: {
    orgId: string;
    clientId: string;
    environment: VaultEnvName;
    itemName?: string;
    host?: string;
    taskDescription?: string;
  },
): Promise<FindItemsResult> {
  const nameRaw = input.itemName?.trim() ?? "";
  const hostRaw = input.host?.trim().toLowerCase() ?? "";
  if (!nameRaw && !hostRaw) {
    throw new HttpError(400, "find_items requires item_name or host");
  }
  let itemName: string | undefined;
  if (nameRaw) {
    try {
      itemName = normalizeSecretName(nameRaw);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : "Invalid name");
    }
  }
  if (hostRaw) {
    assertAllowedHostname(hostRaw, [hostRaw]);
  }
  const client = await host.clientInOrg(input.orgId, input.clientId);
  if (client.environment !== input.environment) {
    throw new HttpError(403, "Client cannot access this environment");
  }
  const env = await host.envFor(input.orgId, input.environment);
  const items = await host.store.listItems(env.id);
  const matched = matchFindItems({
    environment: env.name,
    items,
    itemName,
    host: hostRaw || undefined,
  });
  if (matched.status !== "none") return matched;
  return ensureNeedItem(host, {
    orgId: input.orgId,
    clientId: input.clientId,
    environment: input.environment,
    itemName,
    host: hostRaw,
    taskDescription: input.taskDescription,
    alreadyLimited: false,
  });
}

export async function ensureNeedItem(
  host: NeedHost,
  input: {
    orgId: string;
    clientId: string;
    environment: VaultEnvName;
    itemName?: string;
    host: string;
    taskDescription?: string;
    alreadyLimited?: boolean;
  },
): Promise<NeedItemPayload> {
  if (!input.alreadyLimited && !(await host.limiter.allow(input.orgId, host.now().getTime(), "need"))) {
    throw new HttpError(429, "request_grant rate limit");
  }
  const client = await host.clientInOrg(input.orgId, input.clientId);
  if (client.environment !== input.environment) {
    throw new HttpError(403, "Client cannot access this environment");
  }
  const env = await host.envFor(input.orgId, input.environment);
  const suggestedName = input.itemName ?? suggestedNameFromHost(input.host) ?? "";
  const itemHost = input.host;
  const taskDescription = truncateTask(input.taskDescription);
  const existing = await host.store.getPendingNeed({
    orgId: input.orgId,
    clientId: client.id,
    environmentId: env.id,
    suggestedName,
    host: itemHost,
  });
  const ttl = new Date(host.now().getTime() + host.magicTtlMs).toISOString();
  if (existing && existing.expiresAt >= nowIso(host.now())) {
    await host.store.refreshNeedExpires(existing.id, ttl);
    return needPayload(host, existing.id, suggestedName, itemHost, client.name);
  }
  if (existing) {
    await host.store.cancelNeed(existing.id);
  }
  const row = await host.store.insertPendingNeed({
    id: `nid_${randomUUID()}`,
    orgId: input.orgId,
    clientId: client.id,
    environmentId: env.id,
    suggestedName,
    host: itemHost,
    taskDescription,
    status: "pending",
    itemId: null,
    grantId: null,
    expiresAt: ttl,
    createdAt: nowIso(host.now()),
    fulfilledAt: null,
  });
  await host.audit(input.orgId, "need_created", client.id, suggestedName || null, client.id);
  return needPayload(host, row.id, suggestedName, itemHost, client.name);
}

export async function needItemError(
  host: NeedHost,
  input: {
    orgId: string;
    clientId: string;
    environment: VaultEnvName;
    itemName: string;
    host: string;
    taskDescription?: string;
    alreadyLimited?: boolean;
  },
): Promise<NeedItemError> {
  const payload = await ensureNeedItem(host, {
    orgId: input.orgId,
    clientId: input.clientId,
    environment: input.environment,
    itemName: normalizeSecretName(input.itemName),
    host: input.host,
    taskDescription: input.taskDescription,
    alreadyLimited: input.alreadyLimited,
  });
  return new NeedItemError(payload);
}

export async function getNeed(
  host: NeedHost,
  id: string,
): Promise<{
  need: {
    id: string;
    suggested_name: string;
    host: string;
    client_name: string;
    task_description: string | null;
    status: string;
    expires_at: string;
  };
} | undefined> {
  const row = await host.store.getNeed(id);
  if (!row) return undefined;
  const client = await host.store.getClient(row.clientId);
  return {
    need: {
      id: row.id,
      suggested_name: row.suggestedName,
      host: row.host,
      client_name: client?.name ?? row.clientId,
      task_description: row.taskDescription,
      status: row.status,
      expires_at: row.expiresAt,
    },
  };
}

export async function listInboxNeeds(host: NeedHost, orgId: string): Promise<NeedPublic[]> {
  const rows = await host.store.listPendingNeeds(orgId);
  const out: NeedPublic[] = [];
  for (const row of rows) {
    const client = await host.store.getClient(row.clientId);
    out.push({
      id: row.id,
      suggested_name: row.suggestedName,
      host: row.host,
      client_id: row.clientId,
      client_name: client?.name ?? row.clientId,
      task_description: row.taskDescription,
      collect_path: `/collect/${row.id}`,
      expires_at: row.expiresAt,
      status: row.status,
    });
  }
  assertSafePublicObject("listInboxNeeds", out);
  return out;
}

export async function fulfillNeed(
  host: NeedHost,
  input: {
    orgId: string;
    actor: string;
    needId: string;
    value: string;
    name?: string;
    allowedHosts: string[];
    inject: string;
    kind?: ItemKind;
    username?: string;
  },
): Promise<{ item: ItemPublic; grant_status: string }> {
  const need = await host.store.getNeed(input.needId);
  if (!need || need.orgId !== input.orgId) throw new HttpError(404, "Unknown need");
  if (need.status !== "pending") throw new HttpError(409, "Need is not pending");
  if (need.expiresAt < nowIso(host.now())) throw new HttpError(410, "Need expired");
  host.assertHosts(input.allowedHosts);
  const kind = input.kind ?? "secret";
  const rawName = (input.name ?? need.suggestedName).trim();
  let name: string;
  try {
    name = normalizeSecretName(rawName);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : "Invalid name");
  }
  if (input.value.length === 0) throw new HttpError(400, "Value must not be empty");
  if (Buffer.byteLength(input.value, "utf8") > host.maxItemBytes) {
    throw new HttpError(400, "Value exceeds 64KiB");
  }
  if (kind === "login" && !input.username) {
    throw new HttpError(400, "login items require username");
  }
  const env = await host.store.getEnvironment(need.environmentId);
  if (!env) throw new HttpError(404, "Unknown environment");
  host.assertPlane(env.name);
  const existing = await host.store.getItemByName(env.id, name);
  if (existing) throw new HttpError(409, "Item name already exists in this environment");
  const client = await host.clientInOrg(input.orgId, need.clientId);
  const dek = await host.dekForOrg(input.orgId);
  const payload =
    kind === "login"
      ? JSON.stringify({ username: input.username, password: input.value })
      : input.value;
  const envelope = encrypt(payload, dek, input.orgId);
  const at = nowIso(host.now());
  const itemId = `itm_${randomUUID()}`;
  const item: ItemRecord = {
    id: itemId,
    environmentId: env.id,
    folderId: null,
    kind,
    name,
    last4: last4(input.value),
    username: kind === "login" ? (input.username ?? null) : null,
    allowedHostsJson: JSON.stringify(input.allowedHosts),
    inject: input.inject,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
    tag: envelope.tag,
    createdAt: at,
    updatedAt: at,
  };
  const standing = await host.standingFor(input.orgId, client.id, item);
  const grant: HostedGrantRecord = {
    id: `grt_${randomUUID()}`,
    orgId: input.orgId,
    clientId: client.id,
    itemId,
    folderId: null,
    environmentId: env.id,
    policy: standing ? standing.kind : "prompt",
    status: "active",
    expiresAt: null,
    createdAt: at,
    approvedAt: at,
    consumedAt: null,
    taskId: null,
    taskDescription: need.taskDescription,
  };
  try {
    await host.store.persistFulfill({
      item,
      grant,
      needId: need.id,
      fulfilledAt: at,
      audit: {
        id: `aud_${randomUUID()}`,
        orgId: input.orgId,
        action: "need_fulfilled",
        actor: input.actor,
        itemName: name,
        clientId: client.id,
        at,
      },
    });
  } catch (err) {
    if (err instanceof StoreConflictError) {
      throw new HttpError(409, err.message);
    }
    throw err;
  }
  const result = { item: host.publicItem(env.name, item), grant_status: grant.status };
  assertSafePublicObject("fulfillNeed", result);
  return result;
}
