import { randomUUID } from "node:crypto";
import { encrypt } from "../crypto.ts";
import { last4, normalizeSecretName, nowIso, suggestedNameFromHost } from "../ids.ts";
import { assertSafePublicObject } from "../redact.ts";
import {
  scopeFromPolicy,
  unscopedFields,
  type ClientRecord,
  type FindItemsResult,
  type HostedGrantRecord,
  type ItemKind,
  type ItemPublic,
  type ItemRecord,
  type NeedItemRecord,
  type NeedPublic,
  type PolicyRecord,
  type SetupRecipePublic,
  type VaultEnvName,
} from "../hosted-types.ts";
import { publicRecipe, recipeByHost } from "./providers/setup-recipes.ts";
import type { VaultStore } from "../store/types.ts";
import { StoreConflictError } from "../store/conflict.ts";
import { HttpError, NeedItemError, type NeedItemPayload } from "./errors.ts";
import { itemAad } from "./item-aad.ts";
import { matchFindItems, NEED_ITEM_MESSAGE } from "./need-match.ts";
import { storedItemUsername } from "./store-form-fields.ts";
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
  assertPlanLimit: (orgId: string, kind: "credentials") => Promise<void>;
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

function truncateTask(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  return t.length > TASK_DESC_MAX ? t.slice(0, TASK_DESC_MAX) : t;
}

function collectUrl(host: NeedHost, needId: string): string {
  return `${host.publicUrl.replace(/\/$/, "")}/collect/${needId}`;
}

function recipeForNeedHost(itemHost: string): SetupRecipePublic | undefined {
  const recipe = recipeByHost(itemHost);
  return recipe ? publicRecipe(recipe) : undefined;
}

function needPayload(
  host: NeedHost,
  needId: string,
  suggestedName: string,
  itemHost: string,
  clientName: string,
): NeedItemPayload {
  const recipe = recipeForNeedHost(itemHost);
  const payload: NeedItemPayload = {
    status: "need_item",
    collect_url: collectUrl(host, needId),
    suggested_name: suggestedName,
    host: itemHost,
    client_name: clientName,
    need_id: needId,
    message: NEED_ITEM_MESSAGE,
    ...(recipe ? { recipe } : {}),
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
  const recipe = recipeByHost(input.host);
  const suggestedName = input.itemName ?? recipe?.suggestedName ?? suggestedNameFromHost(input.host) ?? "";
  const itemHost = recipe?.primaryHost ?? input.host;
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
    kind: "secret",
    provider: null,
    sourceItemId: null,
  });
  await host.audit(input.orgId, "need_created", client.id, suggestedName || null, client.id);
  return needPayload(host, row.id, suggestedName, itemHost, client.name);
}

export type ConnectNeedInput = {
  orgId: string;
  clientId: string;
  environment: VaultEnvName;
  /** Registry provider id (`spotify`). */
  providerId: string;
  /** The client-secret item the agent called with; the account is connected for it. */
  sourceItemId: string;
  /** `<ITEM>_REFRESH`: the item the connect callback stores, and the need's `suggested_name`. */
  refreshItemName: string;
  /** The provider API host the call was for. */
  apiHost: string;
  taskDescription?: string;
};

/** Console deep link that opens the connect dialog for the item with the agent and need carried along. */
export function connectUrl(publicUrl: string, input: { sourceItemId: string; providerId: string; clientId: string; needId: string }): string {
  const q = new URLSearchParams({ connect: input.providerId, agent: input.clientId, need: input.needId });
  return `${publicUrl.replace(/\/$/, "")}/console#credentials/item/${encodeURIComponent(input.sourceItemId)}?${q.toString()}`;
}

/**
 * The inbox record behind a `user_connect_required` result: "<agent> needs a <provider> account
 * for <ITEM>". Keyed like a secret need (client, environment, `<ITEM>_REFRESH`, API host), so an
 * agent that keeps calling gets the same row and need id back until the operator connects or
 * denies. No rate limiter: the agent already holds an approved grant on the client-secret item,
 * and repeats reuse the row. Audited `connect_requested` once per row.
 */
export async function ensureConnectNeed(host: NeedHost, input: ConnectNeedInput): Promise<{ need_id: string; connect_url: string }> {
  const client = await host.clientInOrg(input.orgId, input.clientId);
  if (client.environment !== input.environment) {
    throw new HttpError(403, "Client cannot access this environment");
  }
  const env = await host.envFor(input.orgId, input.environment);
  const key = {
    orgId: input.orgId,
    clientId: client.id,
    environmentId: env.id,
    suggestedName: input.refreshItemName,
    host: input.apiHost,
  };
  const ttl = new Date(host.now().getTime() + host.magicTtlMs).toISOString();
  const existing = await host.store.getPendingNeed(key);
  let needId: string;
  if (existing && existing.kind === "connect" && existing.expiresAt >= nowIso(host.now())) {
    await host.store.refreshNeedExpires(existing.id, ttl);
    needId = existing.id;
  } else {
    if (existing) await host.store.cancelNeed(existing.id);
    const row = await host.store.insertPendingNeed({
      ...key,
      id: `nid_${randomUUID()}`,
      taskDescription: truncateTask(input.taskDescription),
      status: "pending",
      itemId: null,
      grantId: null,
      expiresAt: ttl,
      createdAt: nowIso(host.now()),
      fulfilledAt: null,
      kind: "connect",
      provider: input.providerId,
      sourceItemId: input.sourceItemId,
    });
    needId = row.id;
    await host.audit(input.orgId, "connect_requested", client.id, input.refreshItemName, client.id);
  }
  return {
    need_id: needId,
    connect_url: connectUrl(host.publicUrl, { sourceItemId: input.sourceItemId, providerId: input.providerId, clientId: client.id, needId }),
  };
}

/** The operator refused the request from the inbox card. 404 for another org's need, 409 when it is not pending. */
export async function denyNeed(host: NeedHost, input: { orgId: string; actor: string; needId: string }): Promise<void> {
  const need = await host.store.getNeed(input.needId);
  if (!need || need.orgId !== input.orgId) throw new HttpError(404, "Unknown need");
  if (!(await host.store.denyNeed(need.id))) throw new HttpError(409, "Need is not pending");
  await host.audit(input.orgId, "need_denied", input.actor, need.suggestedName || null, need.clientId);
}

/**
 * The provider callback stored `<ITEM>_REFRESH` for the agent that asked: close the connect need
 * it came from. A need that already expired, was denied, or belongs to another org is left alone
 * (the connect itself succeeded either way), so this never fails the callback.
 */
export async function fulfillConnectNeed(
  host: NeedHost,
  input: { orgId: string; actor: string; needId: string; itemId: string },
): Promise<boolean> {
  const need = await host.store.getNeed(input.needId);
  if (!need || need.orgId !== input.orgId || need.kind !== "connect") return false;
  if (!(await host.store.fulfillNeedWithItem(need.id, input.itemId, nowIso(host.now())))) return false;
  await host.audit(input.orgId, "need_fulfilled", input.actor, need.suggestedName || null, need.clientId);
  return true;
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
    kind: NeedItemRecord["kind"];
    provider: string | null;
    suggested_name: string;
    host: string;
    client_name: string;
    task_description: string | null;
    status: string;
    expires_at: string;
    recipe?: SetupRecipePublic;
  };
} | undefined> {
  const row = await host.store.getNeed(id);
  if (!row) return undefined;
  const client = await host.store.getClient(row.clientId);
  return {
    need: {
      id: row.id,
      kind: row.kind,
      provider: row.provider,
      suggested_name: row.suggestedName,
      host: row.host,
      client_name: client?.name ?? row.clientId,
      task_description: row.taskDescription,
      status: row.status,
      expires_at: row.expiresAt,
      recipe: recipeForNeedHost(row.host),
    },
  };
}

export async function listInboxNeeds(host: NeedHost, orgId: string): Promise<NeedPublic[]> {
  const rows = await host.store.listPendingNeeds(orgId);
  const out: NeedPublic[] = [];
  for (const row of rows) {
    const client = await host.store.getClient(row.clientId);
    const source = row.sourceItemId ? await host.store.getItem(row.sourceItemId) : undefined;
    out.push({
      id: row.id,
      kind: row.kind,
      suggested_name: row.suggestedName,
      host: row.host,
      client_id: row.clientId,
      client_name: client?.name ?? row.clientId,
      task_description: row.taskDescription,
      collect_path: row.kind === "secret" ? `/collect/${row.id}` : null,
      provider: row.provider,
      source_item_id: row.sourceItemId,
      source_item_name: source?.name ?? null,
      created_at: row.createdAt,
      expires_at: row.expiresAt,
      status: row.status,
      recipe: recipeForNeedHost(row.host),
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
    alwaysAllow?: boolean;
  },
): Promise<{ item: ItemPublic; grant_status: string }> {
  const need = await host.store.getNeed(input.needId);
  if (!need || need.orgId !== input.orgId) throw new HttpError(404, "Unknown need");
  if (need.status !== "pending") throw new HttpError(409, "Need is not pending");
  if (need.expiresAt < nowIso(host.now())) throw new HttpError(410, "Need expired");
  if (need.kind === "connect") {
    // Nothing is typed in for a connect: the operator connects the account from the inbox card.
    throw new HttpError(409, "This request is a provider connect, not a secret to type in. Use Connect on the inbox card.", {
      kind: "connect",
    });
  }
  host.assertHosts(input.allowedHosts);
  await host.assertPlanLimit(input.orgId, "credentials");
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
  if (kind === "client_secret" && !input.username) {
    throw new HttpError(400, "Client ID and secret items require a Client ID");
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
  const at = nowIso(host.now());
  const itemId = `itm_${randomUUID()}`;
  const allowedHostsJson = JSON.stringify(input.allowedHosts);
  const envelope = encrypt(
    payload,
    dek,
    itemAad({ orgId: input.orgId, itemId, allowedHostsJson, inject: input.inject }),
  );
  const item: ItemRecord = {
    id: itemId,
    environmentId: env.id,
    folderId: null,
    kind,
    name,
    last4: last4(input.value),
    username: storedItemUsername(kind, input.inject, input.username),
    allowedHostsJson,
    inject: input.inject,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
    tag: envelope.tag,
    createdAt: at,
    updatedAt: at,
  };
  const standing = await host.standingFor(input.orgId, client.id, item);
  const alwaysAllow = input.alwaysAllow === true;
  const policy: PolicyRecord | undefined =
    alwaysAllow && !standing
      ? {
          id: `pol_${randomUUID()}`,
          orgId: input.orgId,
          clientId: client.id,
          itemId,
          folderId: null,
          environmentId: env.id,
          kind: "item_standing",
          createdAt: at,
          expiresAt: null,
          ...unscopedFields(),
        }
      : undefined;
  const covering = standing ?? policy;
  const grant: HostedGrantRecord = {
    id: `grt_${randomUUID()}`,
    orgId: input.orgId,
    clientId: client.id,
    itemId,
    folderId: null,
    environmentId: env.id,
    policy: covering ? covering.kind : "prompt",
    status: "active",
    createdAt: at,
    approvedAt: at,
    consumedAt: null,
    taskId: null,
    taskDescription: need.taskDescription,
    requestedScope: null,
    ...scopeFromPolicy(covering),
  };
  try {
    await host.store.persistFulfill({
      item,
      grant,
      policy,
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
  if (policy) {
    await host.audit(input.orgId, "standing_created", input.actor, name, client.id);
  }
  const result = { item: host.publicItem(env.name, item), grant_status: grant.status };
  assertSafePublicObject("fulfillNeed", result);
  return result;
}
