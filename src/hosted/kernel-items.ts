/**
 * Item operations for the hosted kernel: create, rotate, update, delete, list, decrypt (the
 * AAD open), the boot-time rebind of legacy envelopes, and the public projection. Functions
 * take an `ItemHost` with the kernel's store, clock, and helpers, like `kernel-grants.ts`.
 * `HostedKernel` keeps its public method names and delegates here.
 */
import { randomUUID } from "node:crypto";
import { decrypt, encrypt } from "../crypto.ts";
import { last4, normalizeSecretName } from "../ids.ts";
import { assertSafePublicObject } from "../redact.ts";
import type { ClientRecord, EnvironmentRecord, HostedGrantRecord, ItemKind, ItemPublic, ItemRecord, VaultEnvName } from "../hosted-types.ts";
import { ITEM_AAD_VERSION } from "../store/rows.ts";
import type { VaultStore } from "../store/types.ts";
import { environmentsForDeployPlane } from "./deploy-plane.ts";
import { HttpError, type NeedItemError } from "./errors.ts";
import { itemAad, legacyItemAad } from "./item-aad.ts";
import type { ConnectorCall } from "./kernel-grant-scope.ts";
import { logVaultEvent } from "./observe.ts";
import type { PlanLimitKind } from "./plan-limits.ts";
import { assertAllowedHostname } from "./ssrf.ts";
import { itemStoresLoginPayload, storedItemUsername } from "./store-form-fields.ts";

export const MAX_ITEM_BYTES = 64 * 1024;

export type ItemHost = {
  store: VaultStore;
  now: () => Date;
  deployPlane: "staging" | "production";
  /** 404 when this deploy plane may not serve the environment (production items on staging). */
  assertPlane: (name: VaultEnvName) => void;
  envFor: (orgId: string, name: VaultEnvName) => Promise<EnvironmentRecord>;
  dekForOrg: (orgId: string) => Promise<Buffer>;
  assertPlanLimit: (orgId: string, kind: PlanLimitKind) => Promise<void>;
  clientInOrg: (orgId: string, clientId: string) => Promise<ClientRecord>;
  consumeActiveGrant: (orgId: string, clientId: string, itemId: string, call?: ConnectorCall) => Promise<HostedGrantRecord>;
  needItemError: (input: {
    orgId: string;
    clientId: string;
    environment: VaultEnvName;
    itemName: string;
    host: string;
    alreadyLimited: boolean;
  }) => Promise<NeedItemError>;
  audit: (
    orgId: string,
    action: string,
    actor: string,
    itemName: string | null,
    clientId: string | null,
  ) => Promise<void>;
};

/** What `prepareConnector` hands to a connector: the plaintext plus the grant that admitted it. */
export type PreparedItem = DecryptedItem & { grantId: string; grantPolicy: string; itemId: string };

export type ResolveTrustedInput = { orgId: string; clientId: string; itemName: string; environment: VaultEnvName };

export type PrepareConnectorInput = {
  orgId: string;
  clientId: string;
  itemName: string;
  environment: VaultEnvName;
  auditAfterSend?: boolean;
  request?: ConnectorCall;
};

export type CreateItemInput = {
  orgId: string;
  actor: string;
  environment: VaultEnvName;
  kind: ItemKind;
  name: string;
  value: string;
  username?: string;
  allowedHosts: string[];
  inject: string;
  folderName?: string;
};

export type RotateItemInput = { orgId: string; actor: string; itemId: string; value: string };

export type UpdateItemInput = {
  orgId: string;
  actor: string;
  itemId: string;
  name?: string;
  kind?: ItemKind;
  environment?: VaultEnvName;
  username?: string;
  inject?: string;
  allowedHosts?: string[];
  value?: string;
};

/** The plaintext handed to a connector or a trusted runtime. Never serialised to a public surface. */
export type DecryptedItem = {
  secret: string;
  username: string | null;
  last4: string;
  inject: string;
  allowedHosts: string[];
  name: string;
  kind: ItemKind;
};

type PublicItemSource = Pick<
  ItemRecord,
  "id" | "name" | "kind" | "last4" | "username" | "inject" | "allowedHostsJson" | "folderId" | "createdAt" | "updatedAt"
>;

function nowIso(d: Date): string {
  return d.toISOString();
}

/** Item names from clients are user input; a bad name is a 400, not a 500. */
export function normalizeItemName(raw: string): string {
  try {
    return normalizeSecretName(raw);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : "Invalid name");
  }
}

export function parseHosts(json: string): string[] {
  const v: unknown = JSON.parse(json);
  if (!Array.isArray(v) || v.some((h) => typeof h !== "string")) {
    throw new HttpError(500, "Corrupt allowed_hosts");
  }
  return v as string[];
}

export function assertHosts(hosts: string[]): void {
  if (hosts.length === 0) throw new HttpError(400, "allowed_hosts is required");
  for (const h of hosts) {
    assertAllowedHostname(h, [h]);
  }
}

export function publicItem(environment: VaultEnvName, item: PublicItemSource): ItemPublic {
  const pub: ItemPublic = {
    id: item.id,
    name: item.name,
    kind: item.kind,
    last4: item.last4,
    username: item.username,
    environment,
    inject: item.inject,
    allowedHosts: parseHosts(item.allowedHostsJson),
    folderId: item.folderId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  assertSafePublicObject("item", pub);
  return pub;
}

/** Cross-org item ids are 404, never 403, so an id from another tenant reads as unknown. */
export async function assertItemOrg(host: ItemHost, orgId: string, vaultId: string): Promise<void> {
  const vaults = await host.store.listVaults(orgId);
  if (!vaults.some((v) => v.id === vaultId)) throw new HttpError(404, "Unknown item");
}

/** The item by id, when it belongs to this org and its environment is served by this plane. */
async function itemInOrg(host: ItemHost, orgId: string, itemId: string): Promise<{ item: ItemRecord; env: EnvironmentRecord }> {
  const item = await host.store.getItem(itemId);
  if (!item) throw new HttpError(404, "Unknown item");
  const env = await host.store.getEnvironment(item.environmentId);
  if (!env) throw new HttpError(404, "Unknown environment");
  await assertItemOrg(host, orgId, env.vaultId);
  host.assertPlane(env.name);
  return { item, env };
}

function assertValueSize(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_ITEM_BYTES) {
    throw new HttpError(400, "Value exceeds 64KiB");
  }
}

export async function createItem(host: ItemHost, input: CreateItemInput): Promise<ItemPublic> {
  assertHosts(input.allowedHosts);
  const name = normalizeItemName(input.name);
  if (input.value.length === 0) throw new HttpError(400, "Value must not be empty");
  assertValueSize(input.value);
  if (input.kind === "login" && !input.username) {
    throw new HttpError(400, "login items require username");
  }
  if (input.kind === "client_secret" && !input.username) {
    throw new HttpError(400, "Client ID and secret items require a Client ID");
  }
  if (input.inject === "client_credentials" && !input.username) {
    throw new HttpError(400, "client_credentials items require a Client ID in username");
  }
  const username = storedItemUsername(input.kind, input.inject, input.username);
  const env = await host.envFor(input.orgId, input.environment);
  const existing = await host.store.getItemByName(env.id, name);
  if (existing) throw new HttpError(409, "Item name already exists in this environment");
  await host.assertPlanLimit(input.orgId, "credentials");
  let folderId: string | null = null;
  if (input.folderName) {
    const folder = await host.store.getFolderByName(env.id, input.folderName);
    if (!folder) throw new HttpError(404, "Unknown folder");
    folderId = folder.id;
  }
  const dek = await host.dekForOrg(input.orgId);
  const payload =
    input.kind === "login"
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
  await host.store.insertItem({
    id: itemId,
    environmentId: env.id,
    folderId,
    kind: input.kind,
    name,
    last4: last4(input.value),
    username,
    allowedHostsJson,
    inject: input.inject,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
    tag: envelope.tag,
    createdAt: at,
    updatedAt: at,
  });
  await host.audit(input.orgId, "store", input.actor, name, null);
  return publicItem(env.name, {
    id: itemId,
    name,
    kind: input.kind,
    last4: last4(input.value),
    username,
    inject: input.inject,
    allowedHostsJson: JSON.stringify(input.allowedHosts),
    folderId,
    createdAt: at,
    updatedAt: at,
  });
}

export async function rotateItem(host: ItemHost, input: RotateItemInput): Promise<ItemPublic> {
  const { item, env } = await itemInOrg(host, input.orgId, input.itemId);
  if (input.value.length === 0) throw new HttpError(400, "Value must not be empty");
  assertValueSize(input.value);
  const dek = await host.dekForOrg(input.orgId);
  const payload =
    item.kind === "login"
      ? JSON.stringify({ username: item.username, password: input.value })
      : input.value;
  const envelope = encrypt(
    payload,
    dek,
    itemAad({
      orgId: input.orgId,
      itemId: item.id,
      allowedHostsJson: item.allowedHostsJson,
      inject: item.inject,
    }),
  );
  const at = nowIso(host.now());
  await host.store.updateItemEnvelope(item.id, {
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
    tag: envelope.tag,
    last4: last4(input.value),
    updatedAt: at,
  });
  await host.audit(input.orgId, "rotate", input.actor, item.name, null);
  const next = await host.store.getItem(item.id);
  if (!next) throw new HttpError(500, "Rotate failed");
  return publicItem(env.name, next);
}

export async function deleteItem(host: ItemHost, orgId: string, actor: string, itemId: string): Promise<void> {
  const { item } = await itemInOrg(host, orgId, itemId);
  await host.store.deleteItem(itemId);
  await host.audit(orgId, "delete", actor, item.name, null);
}

export async function listItems(host: ItemHost, orgId: string, environment: VaultEnvName): Promise<ItemPublic[]> {
  const env = await host.envFor(orgId, environment);
  const items = await host.store.listItems(env.id);
  const pub = items.map((i) => publicItem(env.name, i));
  assertSafePublicObject("listItems", pub);
  return pub;
}

/** Items in every vault environment this deploy plane may serve. */
export async function listItemsOnPlane(host: ItemHost, orgId: string): Promise<ItemPublic[]> {
  const pub: ItemPublic[] = [];
  for (const environment of environmentsForDeployPlane(host.deployPlane)) {
    pub.push(...(await listItems(host, orgId, environment)));
  }
  assertSafePublicObject("listItemsOnPlane", pub);
  return pub;
}

export async function updateItem(host: ItemHost, input: UpdateItemInput): Promise<ItemPublic> {
  const { item, env } = await itemInOrg(host, input.orgId, input.itemId);
  const nextKind = input.kind ?? item.kind;
  const inject = input.inject ?? item.inject;
  const nextUsernameRaw = input.username !== undefined ? input.username : item.username;
  if (input.allowedHosts) assertHosts(input.allowedHosts);
  if (nextKind === "login" && !storedItemUsername(nextKind, inject, nextUsernameRaw)) {
    throw new HttpError(400, "login items require username");
  }
  if (nextKind === "client_secret" && !storedItemUsername(nextKind, inject, nextUsernameRaw)) {
    throw new HttpError(400, "Client ID and secret items require a Client ID");
  }
  if (inject === "client_credentials" && !storedItemUsername(nextKind, inject, nextUsernameRaw)) {
    throw new HttpError(400, "client_credentials items require a Client ID in username");
  }
  const name = input.name !== undefined ? normalizeItemName(input.name) : item.name;
  let nextEnv = env;
  if (input.environment && input.environment !== env.name) {
    nextEnv = await host.envFor(input.orgId, input.environment);
  }
  if (name !== item.name || nextEnv.id !== item.environmentId) {
    const existing = await host.store.getItemByName(nextEnv.id, name);
    if (existing && existing.id !== item.id) {
      throw new HttpError(409, "Item name already exists in this environment");
    }
  }
  const next = {
    ...item,
    name,
    kind: nextKind,
    environmentId: nextEnv.id,
    inject,
    username: storedItemUsername(nextKind, inject, nextUsernameRaw),
    allowedHostsJson: input.allowedHosts ? JSON.stringify(input.allowedHosts) : item.allowedHostsJson,
    updatedAt: nowIso(host.now()),
  };
  const newValue = input.value !== undefined && input.value.length > 0 ? input.value : undefined;
  const loginShapeChanged = itemStoresLoginPayload(item.kind) !== itemStoresLoginPayload(nextKind);
  const aadChanged = next.allowedHostsJson !== item.allowedHostsJson || next.inject !== item.inject;
  const meta = {
    name: next.name,
    kind: next.kind,
    environmentId: next.environmentId,
    username: next.username,
    inject: next.inject,
    allowedHostsJson: next.allowedHostsJson,
    updatedAt: next.updatedAt,
  };
  if (newValue !== undefined || loginShapeChanged || aadChanged) {
    if (newValue !== undefined) assertValueSize(newValue);
    const secret = newValue ?? (await decryptItem(host, input.orgId, item.id)).secret;
    const payload = itemStoresLoginPayload(nextKind)
      ? JSON.stringify({ username: next.username, password: secret })
      : secret;
    const dek = await host.dekForOrg(input.orgId);
    const envelope = encrypt(
      payload,
      dek,
      itemAad({
        orgId: input.orgId,
        itemId: item.id,
        allowedHostsJson: next.allowedHostsJson,
        inject: next.inject,
      }),
    );
    // One statement: the envelope is bound to allowed_hosts_json and inject, so neither half
    // may land without the other.
    await host.store.updateItemEnvelopeAndMeta(item.id, {
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
      tag: envelope.tag,
      last4: last4(secret),
      ...meta,
    });
  } else {
    await host.store.updateItemMeta(item.id, meta);
  }
  await host.audit(input.orgId, "store", input.actor, next.name, null);
  const saved = await host.store.getItem(item.id);
  if (!saved) throw new HttpError(500, "Update failed");
  return publicItem(nextEnv.name, saved);
}

export async function decryptItem(host: ItemHost, orgId: string, itemId: string): Promise<DecryptedItem> {
  const item = await host.store.getItem(itemId);
  if (!item) throw new HttpError(404, "Unknown item");
  const dek = await host.dekForOrg(orgId);
  const plain = openItemEnvelope(orgId, item, dek);
  const base = {
    username: item.username,
    last4: item.last4,
    inject: item.inject,
    allowedHosts: parseHosts(item.allowedHostsJson),
    name: item.name,
    kind: item.kind,
  };
  if (item.kind !== "login") return { secret: plain, ...base };
  const parsed: unknown = JSON.parse(plain);
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { password?: unknown }).password !== "string") {
    throw new HttpError(500, "Corrupt login item");
  }
  return { secret: (parsed as { password: string }).password, ...base };
}

export async function findStoredItem(host: ItemHost, orgId: string, environment: VaultEnvName, itemName: string) {
  const env = await host.envFor(orgId, environment);
  return host.store.getItemByName(env.id, normalizeItemName(itemName));
}

/** `POST /runtime/resolve`: a trusted (`avt_`) process spends its grant and gets the plaintext. */
export async function resolveTrusted(
  host: ItemHost,
  input: ResolveTrustedInput,
): Promise<{ username: string | null; value: string; inject: string; name: string }> {
  const client = await host.clientInOrg(input.orgId, input.clientId);
  if (client.kind !== "trusted") {
    throw new HttpError(403, "model tokens cannot resolve");
  }
  if (client.environment !== input.environment) {
    throw new HttpError(403, "Client cannot access this environment");
  }
  const env = await host.envFor(input.orgId, input.environment);
  const item = await host.store.getItemByName(env.id, normalizeItemName(input.itemName));
  if (!item) throw new HttpError(404, "Unknown item");
  await host.consumeActiveGrant(input.orgId, client.id, item.id);
  const decrypted = await decryptItem(host, input.orgId, item.id);
  await host.audit(input.orgId, "inject", client.id, decrypted.name, client.id);
  return {
    username: decrypted.username,
    value: decrypted.secret,
    inject: decrypted.inject,
    name: decrypted.name,
  };
}

/**
 * Hands the decrypted item to a connector. Handing out the plaintext is audited as `inject`
 * unless the caller sets `auditAfterSend` and calls `auditInject` with the real outcome once the
 * request has (or has not) left the process. With `request`, a scoped grant must admit the
 * call (method, host, path prefix) or this is 403 `scope_denied` before anything is decrypted.
 */
export async function prepareConnector(host: ItemHost, input: PrepareConnectorInput): Promise<PreparedItem> {
  const client = await host.clientInOrg(input.orgId, input.clientId);
  if (client.environment !== input.environment) {
    throw new HttpError(403, "Client cannot access this environment");
  }
  const env = await host.envFor(input.orgId, input.environment);
  const item = await host.store.getItemByName(env.id, normalizeItemName(input.itemName));
  if (!item) {
    throw await host.needItemError({
      orgId: input.orgId,
      clientId: input.clientId,
      environment: input.environment,
      itemName: input.itemName,
      host: "",
      alreadyLimited: false,
    });
  }
  const grant = await host.consumeActiveGrant(input.orgId, client.id, item.id, input.request);
  const decrypted = await decryptItem(host, input.orgId, item.id);
  if (!input.auditAfterSend) {
    await host.audit(input.orgId, "inject", client.id, decrypted.name, client.id);
  }
  return { ...decrypted, grantId: grant.id, grantPolicy: grant.policy, itemId: item.id };
}

/**
 * Decrypts with the item-bound AAD only. Rows written before binding are re-encrypted once at
 * boot by `rebindLegacyItems`; the inject path never falls back to the legacy `orgId` AAD.
 */
function openItemEnvelope(orgId: string, item: ItemRecord, dek: Buffer): string {
  const envelope = { iv: item.iv, ciphertext: item.ciphertext, tag: item.tag };
  const aad = itemAad({
    orgId,
    itemId: item.id,
    allowedHostsJson: item.allowedHostsJson,
    inject: item.inject,
  });
  return decrypt(envelope, dek, aad);
}

export type RebindResult = {
  /** Envelopes re-encrypted from the legacy `orgId` AAD to the item-bound AAD. */
  rebound: number;
  /** Envelopes already under the item-bound AAD whose `aad_version` was only unrecorded. */
  verified: number;
  /** Envelopes that opened under neither AAD; left at version 0 and reported, never deleted. */
  unreadable: number;
};

/**
 * Boot-time one-shot (G5): every item whose `aad_version` predates the binding is opened
 * under the item-bound AAD (then only marked) or the legacy `orgId` AAD (then re-encrypted in
 * place without touching `updated_at`). Idempotent: a second run finds nothing to do.
 */
export async function rebindLegacyItems(host: ItemHost): Promise<RebindResult> {
  const result: RebindResult = { rebound: 0, verified: 0, unreadable: 0 };
  const deks = new Map<string, Buffer>();
  for (const { item, orgId } of await host.store.listItemsWithLegacyAad()) {
    let dek = deks.get(orgId);
    if (!dek) {
      dek = await host.dekForOrg(orgId);
      deks.set(orgId, dek);
    }
    const envelope = { iv: item.iv, ciphertext: item.ciphertext, tag: item.tag };
    const aad = itemAad({ orgId, itemId: item.id, allowedHostsJson: item.allowedHostsJson, inject: item.inject });
    try {
      decrypt(envelope, dek, aad);
      await host.store.setItemAadVersion(item.id, ITEM_AAD_VERSION);
      result.verified += 1;
      continue;
    } catch {
      // not bound yet
    }
    let plain: string;
    try {
      plain = decrypt(envelope, dek, legacyItemAad(orgId));
    } catch {
      result.unreadable += 1;
      logVaultEvent("aad_rebind_unreadable", { orgId, itemId: item.id });
      continue;
    }
    const rebound = encrypt(plain, dek, aad);
    await host.store.updateItemEnvelope(item.id, {
      iv: rebound.iv,
      ciphertext: rebound.ciphertext,
      tag: rebound.tag,
      last4: item.last4,
      updatedAt: item.updatedAt,
    });
    result.rebound += 1;
  }
  return result;
}
