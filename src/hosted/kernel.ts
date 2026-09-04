import {
  createHmac,
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { decrypt, encrypt } from "../crypto.ts";
import { resolvePublicOrigin } from "../brand.ts";
import { last4, normalizeSecretName } from "../ids.ts";
import { assertSafePublicObject } from "../redact.ts";
import {
  emptyClientFields,
  type AccessEventRecord,
  type ApprovalChallengeRecord,
  type ClientRecord,
  type FindItemsResult,
  type GrantPolicy,
  type HostedGrantRecord,
  type ItemKind,
  type ItemPublic,
  type ItemRecord,
  type MemberRole,
  type VaultEnvName,
} from "../hosted-types.ts";
import { isUniqueViolation, StoreConflictError } from "../store/conflict.ts";
import type { VaultStore } from "../store/types.ts";
import { escapeHtml } from "./auth-shell.ts";
import { deployPlaneAllowsEnvironment, environmentsForDeployPlane } from "./deploy-plane.ts";
import { HttpError } from "./errors.ts";
import { itemAad, legacyItemAad } from "./item-aad.ts";
import { generateDek, unwrapDek, wrapDek } from "./kek.ts";
import {
  ensureNeedItem,
  findItems,
  fulfillNeed,
  getNeed,
  listInboxNeeds,
  needItemError,
  type NeedHost,
} from "./need-ops.ts";
import { clientUsage, grantUsage, sessionUsage } from "./access-usage.ts";
import {
  acceptInvite,
  cancelInvite,
  inviteMember,
  listOrgsForUser,
  listTeam,
  previewInvite,
  removeMember,
  seatsInUse,
  setActiveOrg,
  updateMemberRole,
  type InvitePreview,
  type MemberHost,
  type OrgSummary,
  type PendingInvite,
  type TeamMember,
  type TeamSnapshot,
} from "./kernel-members.ts";
import { destroyOidcPayloadsForClient } from "./oidc-adapter.ts";
import { logVaultEvent } from "./observe.ts";
import {
  assertWithinLimit,
  monthStartIso,
  planLimits,
  type PlanLimitKind,
  type PlanLimits,
  type PlanReport,
  type PlanUsage,
} from "./plan-limits.ts";
import { OrgRateLimiter } from "./rate-limit.ts";
import { assertAllowedHostname } from "./ssrf.ts";
import { IdentityKeyring, type IdentityRotateResult } from "./identity-keys.ts";
import { itemStoresLoginPayload, storedItemUsername } from "./store-form-fields.ts";
import {
  chooseSpotifyRedirect,
  mintSpotifyAccessToken,
  openOauthState,
  pkceVerifier,
  refreshItemName,
  sealOauthState,
  spotifyAuthorizeUrl,
  SPOTIFY_ACCOUNTS_HOST,
  SPOTIFY_API_HOST,
} from "./spotify.ts";

const SESSION_TTL_MS = 8 * 3600 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAGIC_TTL_MS = 15 * 60 * 1000;
const MAX_ITEM_BYTES = 64 * 1024;
/** Access shows `idHash.slice(0, 12)`; anything shorter is not a session id. */
const SESSION_ID_MIN_CHARS = 12;

/** Single-operator org when `VAULT_BOOTSTRAP_TOKEN` is set. */
export const BOOTSTRAP_ORG_ID = "org_bootstrap";
export const BOOTSTRAP_USER_ID = "user_bootstrap";

export type HostedKernelOpts = {
  store: VaultStore;
  kek: Buffer;
  now?: () => Date;
  sendEmail?: (to: string, subject: string, html: string) => Promise<void>;
  publicUrl?: string;
  approvalHmac?: Buffer;
  deployPlane?: "staging" | "production";
  limiter?: OrgRateLimiter;
  /** Plan limits (3.9). Defaults to the free tier with the `VAULT_PLAN_LIMITS_JSON` override. */
  planLimits?: PlanLimits;
};

function nowIso(d: Date): string {
  return d.toISOString();
}

function hashSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function hashCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function parseHosts(json: string): string[] {
  const v: unknown = JSON.parse(json);
  if (!Array.isArray(v) || v.some((h) => typeof h !== "string")) {
    throw new HttpError(500, "Corrupt allowed_hosts");
  }
  return v as string[];
}

/** Item names from clients are user input; a bad name is a 400, not a 500. */
function normalizeItemName(raw: string): string {
  try {
    return normalizeSecretName(raw);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : "Invalid name");
  }
}

function isPast(iso: string | null, now: Date): boolean {
  return iso !== null && new Date(iso).getTime() < now.getTime();
}

export type InjectOutcome = "inject" | "inject_denied" | "inject_failed";

export class HostedKernel {
  readonly store: VaultStore;
  readonly #kek: Buffer;
  readonly now: () => Date;
  readonly sendEmail: HostedKernelOpts["sendEmail"];
  readonly publicUrl: string;
  readonly approvalHmac: Buffer | undefined;
  readonly deployPlane: "staging" | "production";
  readonly limiter: OrgRateLimiter;
  readonly planLimits: PlanLimits;

  constructor(opts: HostedKernelOpts) {
    this.store = opts.store;
    this.#kek = opts.kek;
    this.now = opts.now ?? (() => new Date());
    this.sendEmail = opts.sendEmail;
    this.approvalHmac = opts.approvalHmac;
    this.planLimits = opts.planLimits ?? planLimits();
    this.deployPlane = opts.deployPlane ?? "production";
    this.publicUrl = resolvePublicOrigin(opts.publicUrl ?? "http://127.0.0.1:8788", {
      plane: this.deployPlane,
      allowLoopback: true,
    });
    this.limiter = opts.limiter ?? new OrgRateLimiter(opts.store);
  }

  async ping(): Promise<void> {
    await this.store.ping();
  }

  async createOrg(name: string, userId: string): Promise<{ orgId: string }> {
    const orgId = `org_${randomUUID()}`;
    await this.#provisionOrg(orgId, name, userId);
    return { orgId };
  }

  async ensureBootstrapOperator(): Promise<{ orgId: string; userId: string; role: MemberRole }> {
    const orgId = BOOTSTRAP_ORG_ID;
    const userId = BOOTSTRAP_USER_ID;
    const existing = await this.store.getOrg(orgId);
    if (!existing) {
      await this.#provisionOrg(orgId, "personal", userId);
    } else if (!(await this.store.getMember(orgId, userId))) {
      await this.store.insertMember({ orgId, userId, role: "owner" });
    }
    const role = await this.requireMember(orgId, userId);
    return { orgId, userId, role };
  }

  async #provisionOrg(orgId: string, name: string, userId: string): Promise<void> {
    const dek = generateDek();
    const wrapped = wrapDek(dek, this.#kek, orgId);
    const at = nowIso(this.now());
    await this.store.insertOrg({
      id: orgId,
      name,
      wrappedDekIv: wrapped.iv,
      wrappedDekCiphertext: wrapped.ciphertext,
      wrappedDekTag: wrapped.tag,
      createdAt: at,
    });
    await this.store.insertMember({ orgId, userId, role: "owner", joinedAt: at });
    const vaultId = `vlt_${randomUUID()}`;
    await this.store.insertVault({ id: vaultId, orgId, name: "default" });
    await this.store.insertEnvironment({
      id: `env_${randomUUID()}`,
      vaultId,
      name: "staging",
    });
    await this.store.insertEnvironment({
      id: `env_${randomUUID()}`,
      vaultId,
      name: "production",
    });
  }

  async addMember(orgId: string, userId: string, role: MemberRole): Promise<void> {
    await this.store.insertMember({ orgId, userId, role, joinedAt: nowIso(this.now()) });
  }

  /* ---- team (3.7) ---- */

  #memberHost(): MemberHost {
    return {
      store: this.store,
      now: this.now,
      publicUrl: this.publicUrl,
      planLimits: this.planLimits,
      sendEmail: this.sendEmail,
      audit: (orgId, action, actor, itemName, clientId) => this.#audit(orgId, action, actor, itemName, clientId),
    };
  }

  async listTeam(orgId: string): Promise<TeamSnapshot> {
    const snap = await listTeam(this.#memberHost(), orgId);
    assertSafePublicObject("listTeam", snap);
    return snap;
  }

  async inviteMember(input: {
    orgId: string;
    actorUserId: string;
    actorRole: MemberRole;
    email: string;
    role: MemberRole;
  }): Promise<{ invite: PendingInvite; accept_url: string; email_sent: boolean }> {
    return inviteMember(this.#memberHost(), input);
  }

  async cancelInvite(input: { orgId: string; actorUserId: string; actorRole: MemberRole; inviteId: string }): Promise<void> {
    return cancelInvite(this.#memberHost(), input);
  }

  async updateMemberRole(input: {
    orgId: string;
    actorUserId: string;
    actorRole: MemberRole;
    userId: string;
    role: MemberRole;
  }): Promise<TeamMember> {
    return updateMemberRole(this.#memberHost(), input);
  }

  async removeMember(input: { orgId: string; actorUserId: string; actorRole: MemberRole; userId: string }): Promise<void> {
    return removeMember(this.#memberHost(), input);
  }

  async previewInvite(token: string): Promise<InvitePreview> {
    return previewInvite(this.#memberHost(), token);
  }

  async acceptInvite(input: { userId: string; email: string; token: string }): Promise<{ org_id: string; org_name: string; role: MemberRole }> {
    return acceptInvite(this.#memberHost(), input);
  }

  async listOrgsForUser(userId: string, activeOrgId: string): Promise<OrgSummary[]> {
    return listOrgsForUser(this.#memberHost(), userId, activeOrgId);
  }

  async setActiveOrg(input: { userId: string; sessionHash: string; orgId: string }): Promise<OrgSummary> {
    return setActiveOrg(this.#memberHost(), input);
  }

  /* ---- plan limits (3.9) ---- */

  /** Current usage for one limit kind. `credentials` spans every environment, not just the plane. */
  async planUsageFor(orgId: string, kind: PlanLimitKind): Promise<number> {
    switch (kind) {
      case "credentials":
        return this.store.countItemsForOrg(orgId);
      case "agents":
        return (await this.store.listClients(orgId)).filter((c) => !c.revokedAt).length;
      case "members":
        return seatsInUse(this.#memberHost(), orgId);
      case "calls":
        return this.store.countAuditSince(orgId, "inject", monthStartIso(this.now()));
      default: {
        const exhaustive: never = kind;
        throw new Error(`Unhandled plan limit kind: ${String(exhaustive)}`);
      }
    }
  }

  /** 402 `plan_limit` when one more `kind` would exceed the org's plan. */
  async assertPlanLimit(orgId: string, kind: PlanLimitKind): Promise<void> {
    assertWithinLimit(kind, await this.planUsageFor(orgId, kind), this.planLimits);
  }

  /**
   * Monthly `http_request` budget. Not called by the connector yet (that wiring belongs to the
   * connector unit); exposed so `runHttpRequest` can call it before `prepareConnector`.
   */
  async assertCallBudget(orgId: string): Promise<void> {
    await this.assertPlanLimit(orgId, "calls");
  }

  async planReport(orgId: string): Promise<PlanReport> {
    const usage: PlanUsage = {
      credentials: await this.planUsageFor(orgId, "credentials"),
      agents: await this.planUsageFor(orgId, "agents"),
      members: await this.planUsageFor(orgId, "members"),
      calls: await this.planUsageFor(orgId, "calls"),
    };
    return { plan: "free", limits: this.planLimits, usage, period_start: monthStartIso(this.now()) };
  }

  async createFolder(orgId: string, environment: VaultEnvName, name: string): Promise<{ id: string; name: string }> {
    const env = await this.envFor(orgId, environment);
    const existing = await this.store.getFolderByName(env.id, name);
    if (existing) throw new HttpError(409, "Folder already exists");
    const id = `fld_${randomUUID()}`;
    await this.store.insertFolder({ id, environmentId: env.id, name });
    return { id, name };
  }

  async requireMember(orgId: string, userId: string): Promise<MemberRole> {
    const m = await this.store.getMember(orgId, userId);
    if (!m) throw new HttpError(403, "Not a member of this org");
    return m.role;
  }

  async envFor(orgId: string, name: VaultEnvName) {
    this.#assertPlane(name);
    const vaults = await this.store.listVaults(orgId);
    const vault = vaults[0];
    if (!vault) throw new HttpError(500, "Org has no vault");
    const env = await this.store.getEnvironmentByName(vault.id, name);
    if (!env) throw new HttpError(404, "Environment not found");
    return env;
  }

  #assertPlane(name: VaultEnvName): void {
    if (!deployPlaneAllowsEnvironment(this.deployPlane, name)) {
      throw new HttpError(404, "Production items are not available on the staging deploy");
    }
  }

  async dekForOrg(orgId: string): Promise<Buffer> {
    const org = await this.store.getOrg(orgId);
    if (!org) throw new HttpError(404, "Unknown org");
    return unwrapDek(
      {
        iv: org.wrappedDekIv,
        ciphertext: org.wrappedDekCiphertext,
        tag: org.wrappedDekTag,
      },
      this.#kek,
      orgId,
    );
  }

  async rotateKek(
    oldKek: Buffer,
    newKek: Buffer,
  ): Promise<{ rewrapped: number; skipped: number; identity: IdentityRotateResult }> {
    const orgs = await this.store.listOrgs();
    let rewrapped = 0;
    let skipped = 0;
    for (const org of orgs) {
      const envelope = {
        iv: org.wrappedDekIv,
        ciphertext: org.wrappedDekCiphertext,
        tag: org.wrappedDekTag,
      };
      try {
        unwrapDek(envelope, newKek, org.id);
        skipped += 1;
        continue;
      } catch {
        // still on old KEK
      }
      const dek = unwrapDek(envelope, oldKek, org.id);
      const next = wrapDek(dek, newKek, org.id);
      await this.store.updateOrgWrappedDek(org.id, {
        wrappedDekIv: next.iv,
        wrappedDekCiphertext: next.ciphertext,
        wrappedDekTag: next.tag,
      });
      rewrapped += 1;
    }
    const identity = await new IdentityKeyring(this.store, oldKek, this.now).rotateKek(oldKek, newKek);
    return { rewrapped, skipped, identity };
  }

  async rotateClient(
    orgId: string,
    actor: string,
    clientId: string,
  ): Promise<{ token: string; client_id: string }> {
    const client = await this.#clientInOrg(orgId, clientId);
    const prefix = client.kind === "trusted" ? "avt_" : "avm_";
    const plaintext = `${prefix}${randomBytes(24).toString("hex")}`;
    await this.store.updateClientHashedSecret(client.id, hashSecret(plaintext), last4(plaintext));
    await this.#audit(orgId, "client_rotate", actor, null, client.id);
    return { token: plaintext, client_id: client.id };
  }

  async createItem(input: {
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
  }): Promise<ItemPublic> {
    this.#assertHosts(input.allowedHosts);
    const name = normalizeItemName(input.name);
    if (input.value.length === 0) throw new HttpError(400, "Value must not be empty");
    if (Buffer.byteLength(input.value, "utf8") > MAX_ITEM_BYTES) {
      throw new HttpError(400, "Value exceeds 64KiB");
    }
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
    const env = await this.envFor(input.orgId, input.environment);
    const existing = await this.store.getItemByName(env.id, name);
    if (existing) throw new HttpError(409, "Item name already exists in this environment");
    await this.assertPlanLimit(input.orgId, "credentials");
    let folderId: string | null = null;
    if (input.folderName) {
      const folder = await this.store.getFolderByName(env.id, input.folderName);
      if (!folder) throw new HttpError(404, "Unknown folder");
      folderId = folder.id;
    }
    const dek = await this.dekForOrg(input.orgId);
    const payload =
      input.kind === "login"
        ? JSON.stringify({ username: input.username, password: input.value })
        : input.value;
    const at = nowIso(this.now());
    const itemId = `itm_${randomUUID()}`;
    const allowedHostsJson = JSON.stringify(input.allowedHosts);
    const envelope = encrypt(
      payload,
      dek,
      itemAad({ orgId: input.orgId, itemId, allowedHostsJson, inject: input.inject }),
    );
    await this.store.insertItem({
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
    await this.#audit(input.orgId, "store", input.actor, name, null);
    return this.#publicItem(env.name, {
      id: itemId,
      name,
      kind: input.kind,
      last4: last4(input.value),
      username,
      inject: input.inject,
      allowedHostsJson: JSON.stringify(input.allowedHosts),
      folderId,
    });
  }

  async rotateItem(input: {
    orgId: string;
    actor: string;
    itemId: string;
    value: string;
  }): Promise<ItemPublic> {
    const item = await this.store.getItem(input.itemId);
    if (!item) throw new HttpError(404, "Unknown item");
    const env = await this.store.getEnvironment(item.environmentId);
    if (!env) throw new HttpError(404, "Unknown environment");
    await this.#assertItemOrg(input.orgId, env.vaultId);
    if (input.value.length === 0) throw new HttpError(400, "Value must not be empty");
    const dek = await this.dekForOrg(input.orgId);
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
    const at = nowIso(this.now());
    await this.store.updateItemEnvelope(item.id, {
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
      tag: envelope.tag,
      last4: last4(input.value),
      updatedAt: at,
    });
    await this.#audit(input.orgId, "rotate", input.actor, item.name, null);
    const next = await this.store.getItem(item.id);
    if (!next) throw new HttpError(500, "Rotate failed");
    return this.#publicItem(env.name, next);
  }

  async deleteItem(orgId: string, actor: string, itemId: string): Promise<void> {
    const item = await this.store.getItem(itemId);
    if (!item) throw new HttpError(404, "Unknown item");
    const env = await this.store.getEnvironment(item.environmentId);
    if (!env) throw new HttpError(404, "Unknown environment");
    await this.#assertItemOrg(orgId, env.vaultId);
    await this.store.deleteItem(itemId);
    await this.#audit(orgId, "delete", actor, item.name, null);
  }

  async listItems(orgId: string, environment: VaultEnvName): Promise<ItemPublic[]> {
    const env = await this.envFor(orgId, environment);
    const items = await this.store.listItems(env.id);
    const pub = items.map((i) => this.#publicItem(env.name, i));
    assertSafePublicObject("listItems", pub);
    return pub;
  }

  /** Items in every vault environment this deploy plane may serve. */
  async listItemsOnPlane(orgId: string): Promise<ItemPublic[]> {
    const pub: ItemPublic[] = [];
    for (const environment of environmentsForDeployPlane(this.deployPlane)) {
      pub.push(...(await this.listItems(orgId, environment)));
    }
    assertSafePublicObject("listItemsOnPlane", pub);
    return pub;
  }

  #needHost(): NeedHost {
    return {
      store: this.store,
      limiter: this.limiter,
      publicUrl: this.publicUrl,
      now: this.now,
      magicTtlMs: MAGIC_TTL_MS,
      maxItemBytes: MAX_ITEM_BYTES,
      envFor: (orgId, name) => this.envFor(orgId, name),
      dekForOrg: (orgId) => this.dekForOrg(orgId),
      clientInOrg: (orgId, clientId) => this.#clientInOrg(orgId, clientId),
      assertHosts: (hosts) => this.#assertHosts(hosts),
      assertPlane: (name) => this.#assertPlane(name),
      standingFor: (orgId, clientId, item) => this.#standingFor(orgId, clientId, item),
      publicItem: (environment, item) => this.#publicItem(environment, item),
      audit: (orgId, action, actor, itemName, clientId) =>
        this.#audit(orgId, action, actor, itemName, clientId),
    };
  }

  async findItems(input: {
    orgId: string;
    clientId: string;
    environment: VaultEnvName;
    itemName?: string;
    host?: string;
    taskDescription?: string;
  }): Promise<FindItemsResult> {
    return findItems(this.#needHost(), input);
  }

  async ensureNeedItem(input: {
    orgId: string;
    clientId: string;
    environment: VaultEnvName;
    itemName?: string;
    host: string;
    taskDescription?: string;
    alreadyLimited?: boolean;
  }) {
    return ensureNeedItem(this.#needHost(), input);
  }

  async needItemError(input: {
    orgId: string;
    clientId: string;
    environment: VaultEnvName;
    itemName: string;
    host: string;
    taskDescription?: string;
    alreadyLimited?: boolean;
  }) {
    return needItemError(this.#needHost(), input);
  }

  async getNeed(id: string) {
    return getNeed(this.#needHost(), id);
  }

  async listInboxNeeds(orgId: string) {
    return listInboxNeeds(this.#needHost(), orgId);
  }

  async fulfillNeed(input: {
    orgId: string;
    actor: string;
    needId: string;
    value: string;
    name?: string;
    allowedHosts: string[];
    inject: string;
    kind?: ItemKind;
    username?: string;
  }) {
    return fulfillNeed(this.#needHost(), input);
  }

  async createTrustedClient(input: {
    orgId: string;
    name: string;
    environment: VaultEnvName;
  }): Promise<{ client: ClientRecord; plaintext: string }> {
    this.#assertPlane(input.environment);
    await this.assertPlanLimit(input.orgId, "agents");
    const plaintext = `avt_${randomBytes(24).toString("hex")}`;
    const id = `cli_${randomUUID()}`;
    const row: ClientRecord = {
      id,
      orgId: input.orgId,
      kind: "trusted",
      name: input.name,
      hashedSecret: hashSecret(plaintext),
      clerkOauthUserId: null,
      environment: input.environment,
      ...emptyClientFields(),
      last4: last4(plaintext),
    };
    await this.store.insertClient(row);
    await this.#recordMachineIssue(row, plaintext);
    return { client: row, plaintext };
  }

  async createModelClient(input: {
    orgId: string;
    name: string;
    environment: VaultEnvName;
    clerkOauthUserId?: string;
    issueBearer?: boolean;
  }): Promise<{ client: ClientRecord; plaintext?: string }> {
    this.#assertPlane(input.environment);
    await this.assertPlanLimit(input.orgId, "agents");
    const plaintext = input.issueBearer === true ? `avm_${randomBytes(24).toString("hex")}` : undefined;
    const row: ClientRecord = {
      id: `cli_${randomUUID()}`,
      orgId: input.orgId,
      kind: "model",
      name: input.name,
      hashedSecret: plaintext ? hashSecret(plaintext) : null,
      clerkOauthUserId: input.clerkOauthUserId ?? null,
      environment: input.environment,
      ...emptyClientFields(),
      last4: plaintext ? last4(plaintext) : null,
      oauthClientId: input.clerkOauthUserId ?? null,
    };
    await this.store.insertClient(row);
    if (plaintext) await this.#recordMachineIssue(row, plaintext);
    return { client: row, plaintext };
  }

  /** Reuses the live model client for this OAuth id. Revoked clients are never resurrected. */
  async ensureModelClient(input: {
    orgId: string;
    name: string;
    environment: VaultEnvName;
    clerkOauthUserId: string;
  }): Promise<ClientRecord> {
    const clients = await this.store.listClients(input.orgId);
    const matches = clients.filter(
      (c) =>
        c.kind === "model" &&
        (c.oauthClientId === input.clerkOauthUserId || c.clerkOauthUserId === input.clerkOauthUserId),
    );
    const active = matches.find((c) => !c.revokedAt);
    if (active) return active;
    // (org_id, oauth_client_id) is unique, so a revoked row is reactivated by a fresh consent
    // rather than duplicated. Its refresh tokens were destroyed at revoke; new ones are issued now.
    const revoked = matches[0];
    if (revoked) {
      await this.store.setClientRevoked(revoked.id, null);
      await this.#audit(input.orgId, "client_reactivated", "oauth", null, revoked.id);
      const fresh = await this.store.getClient(revoked.id);
      if (fresh) return fresh;
    }
    const created = await this.createModelClient(input);
    return created.client;
  }

  /** Operator-only. Moves a client (including OAuth-issued ones) to another vault environment. */
  async setClientEnvironment(
    orgId: string,
    actor: string,
    clientId: string,
    environment: VaultEnvName,
  ): Promise<ClientRecord> {
    this.#assertPlane(environment);
    const client = await this.#clientInOrg(orgId, clientId);
    if (client.revokedAt) throw new HttpError(409, "Client is revoked");
    if (client.environment !== environment) {
      await this.store.updateClientEnvironment(client.id, environment);
      await this.#audit(orgId, "client_environment", actor, null, client.id);
    }
    return { ...client, environment };
  }

  async lookupTrusted(orgId: string, token: string): Promise<ClientRecord | undefined> {
    return this.store.getClientByHashedSecret(orgId, hashSecret(token));
  }

  async lookupTrustedToken(token: string): Promise<ClientRecord | undefined> {
    return this.store.findClientByHashedSecret(hashSecret(token));
  }

  /**
   * One open grant per (client, item). A standing policy activates immediately; otherwise the
   * existing pending grant is reused with a fresh approval code. The org limiter is counted here
   * exactly once per call, whichever surface (REST, request_grant, http_request) asked.
   * Notification goes to `operatorEmail` (must be a member) or to every member; it is sent for a
   * new grant or when the previous magic link expired, never on every retry.
   */
  async requestGrant(input: {
    orgId: string;
    clientId: string;
    itemName: string;
    environment: VaultEnvName;
    taskId?: string;
    taskDescription?: string;
    operatorEmail?: string;
  }): Promise<{ grant: HostedGrantRecord; code?: string; notifyFailed?: boolean }> {
    if (!(await this.limiter.allow(input.orgId, this.now().getTime(), "grant"))) {
      throw new HttpError(429, "request_grant rate limit");
    }
    const client = await this.#clientInOrg(input.orgId, input.clientId);
    if (client.environment !== input.environment) {
      throw new HttpError(403, "Client cannot access this environment");
    }
    const env = await this.envFor(input.orgId, input.environment);
    const item = await this.store.getItemByName(env.id, normalizeItemName(input.itemName));
    if (!item) {
      throw await this.needItemError({
        orgId: input.orgId,
        clientId: input.clientId,
        environment: input.environment,
        itemName: input.itemName,
        host: "",
        taskDescription: input.taskDescription,
        alreadyLimited: true,
      });
    }
    const recipients = await this.#notifyRecipients(input.orgId, input.operatorEmail);
    const standing = await this.#standingFor(input.orgId, client.id, item);
    const now = this.now();
    const at = nowIso(now);
    const open = await this.#openGrantFor(input.orgId, client.id, item.id);
    let grant: HostedGrantRecord;
    if (open && open.status === "active") {
      grant = open;
    } else if (standing) {
      grant = open
        ? { ...open, policy: standing.kind, status: "active", approvedAt: at, expiresAt: null }
        : this.#newGrant(input, client.id, item, env.id, at, standing.kind, "active");
      if (open) await this.store.updateGrant(grant);
      else await this.store.insertGrant(grant);
    } else if (open) {
      grant = open;
    } else {
      grant = this.#newGrant(input, client.id, item, env.id, at, "prompt", "pending");
      await this.store.insertGrant(grant);
    }
    await this.#audit(input.orgId, "request_grant", client.id, item.name, client.id);
    if (grant.status === "active") {
      assertSafePublicObject("requestGrant", grant);
      return { grant };
    }
    const code = await this.#rotateCodeChallenge(grant.id, now);
    const magic = await this.#ensureMagicChallenge(grant.id, now);
    let notifyFailed = false;
    if (!open || magic.fresh) {
      notifyFailed = !(await this.#notify(input.orgId, recipients, client, item, magic.token));
    }
    assertSafePublicObject("requestGrant", grant);
    return { grant, code, notifyFailed };
  }

  #newGrant(
    input: { orgId: string; taskId?: string; taskDescription?: string },
    clientId: string,
    item: { id: string; folderId: string | null },
    environmentId: string,
    at: string,
    policy: GrantPolicy,
    status: "active" | "pending",
  ): HostedGrantRecord {
    return {
      id: `grt_${randomUUID()}`,
      orgId: input.orgId,
      clientId,
      itemId: item.id,
      folderId: item.folderId,
      environmentId,
      policy,
      status,
      expiresAt: null,
      createdAt: at,
      approvedAt: status === "active" ? at : null,
      consumedAt: null,
      taskId: input.taskId ?? null,
      taskDescription: input.taskDescription ?? null,
    };
  }

  /** Newest pending or unexpired active grant for the pair; active wins over pending. */
  async #openGrantFor(orgId: string, clientId: string, itemId: string): Promise<HostedGrantRecord | undefined> {
    const grants = await this.#settleExpired(await this.store.listGrants(orgId));
    const pair = grants.filter((g) => g.clientId === clientId && g.itemId === itemId);
    return pair.find((g) => g.status === "active") ?? pair.find((g) => g.status === "pending");
  }

  /** D15: an active `session` grant past `expires_at` reads as `expired`. */
  async #settleExpired(grants: HostedGrantRecord[]): Promise<HostedGrantRecord[]> {
    const now = this.now();
    const out: HostedGrantRecord[] = [];
    for (const g of grants) {
      if (g.status === "active" && isPast(g.expiresAt, now)) {
        const expired: HostedGrantRecord = { ...g, status: "expired" };
        await this.store.updateGrant(expired);
        out.push(expired);
      } else {
        out.push(g);
      }
    }
    return out;
  }

  async #rotateCodeChallenge(grantId: string, now: Date): Promise<string> {
    const prior = await this.store.getChallengeByGrantKind(grantId, "code");
    if (prior) await this.store.deleteChallenge(prior.id);
    const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
    const salt = randomBytes(8).toString("hex");
    await this.store.insertChallenge({
      id: `chl_${randomUUID()}`,
      grantId,
      codeHash: `${salt}:${hashCode(code, salt)}`,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
      attempts: 0,
      kind: "code",
    });
    return code;
  }

  /** Keeps an unexpired magic link; mints a new one otherwise. `fresh` means a new link was made. */
  async #ensureMagicChallenge(grantId: string, now: Date): Promise<{ token?: string; fresh: boolean }> {
    if (!this.approvalHmac) return { fresh: true };
    const prior = await this.store.getChallengeByGrantKind(grantId, "magic");
    if (prior && !isPast(prior.expiresAt, now)) return { token: prior.codeHash, fresh: false };
    if (prior) await this.store.deleteChallenge(prior.id);
    const exp = now.getTime() + MAGIC_TTL_MS;
    const token = mintApprovalToken(this.approvalHmac, grantId, exp);
    await this.store.insertChallenge({
      id: `chl_${randomUUID()}`,
      grantId,
      codeHash: token,
      expiresAt: new Date(exp).toISOString(),
      attempts: 0,
      kind: "magic",
    });
    return { token, fresh: true };
  }

  /** An explicit `operatorEmail` wins; otherwise every member with a verified email is notified. */
  async #notifyRecipients(orgId: string, operatorEmail: string | undefined): Promise<string[]> {
    if (operatorEmail !== undefined) return [operatorEmail.trim().toLowerCase()];
    return this.store.listMemberEmails(orgId);
  }

  /** REST boundary check for `operator_email`: only this org's members may be addressed. */
  async assertMemberEmail(orgId: string, email: string): Promise<string> {
    const wanted = email.trim().toLowerCase();
    const members = await this.store.listMemberEmails(orgId);
    if (!members.some((m) => m.toLowerCase() === wanted)) {
      throw new HttpError(400, "operator_email must be a member of this org");
    }
    return wanted;
  }

  /** Sends the approval email to each recipient. True when at least one send succeeded. */
  async #notify(
    orgId: string,
    recipients: string[],
    client: ClientRecord,
    item: { name: string; last4: string },
    magicToken: string | undefined,
  ): Promise<boolean> {
    let sent = 0;
    if (this.sendEmail && recipients.length > 0) {
      const link = magicToken
        ? `${this.publicUrl}/approve?token=${encodeURIComponent(magicToken)}`
        : `${this.publicUrl.replace(/\/$/, "")}/console`;
      const html =
        `<p>Client ${escapeHtml(client.name)} requested ${escapeHtml(item.name)} (••••${escapeHtml(item.last4)}).</p>` +
        `<p>Approve in inbox or use the code in the agent result.</p>` +
        `<p><a href="${escapeHtml(link)}">Approve</a></p>`;
      for (const to of recipients) {
        try {
          await this.sendEmail(to, `Grant request ${item.name}`, html);
          sent += 1;
        } catch {
          // counted below
        }
      }
    }
    if (sent === 0) {
      await this.#audit(orgId, "notify_failed", "system", item.name, client.id);
      return false;
    }
    return true;
  }

  async approveGrant(input: {
    orgId: string;
    grantId: string;
    policy: GrantPolicy;
    confirmName?: string;
    role: MemberRole;
    actor: string;
  }): Promise<HostedGrantRecord> {
    const grant = await this.store.getGrant(input.grantId);
    if (!grant || grant.orgId !== input.orgId) throw new HttpError(404, "Unknown grant");
    if (grant.status !== "pending") throw new HttpError(409, "Grant is not pending");
    if (input.policy === "folder_standing" && input.role !== "owner") {
      throw new HttpError(403, "Only owners may approve folder_standing");
    }
    const env = await this.store.getEnvironment(grant.environmentId);
    if (!env) throw new HttpError(404, "Unknown environment");
    if (input.policy === "folder_standing") {
      const folder = grant.folderId ? await this.store.getFolder(grant.folderId) : undefined;
      const expected = folder?.name ?? env.name;
      if (input.confirmName !== expected) {
        throw new HttpError(400, "confirm_name does not match folder or environment");
      }
    }
    const at = nowIso(this.now());
    const expiresAt =
      input.policy === "session"
        ? new Date(this.now().getTime() + SESSION_TTL_MS).toISOString()
        : null;
    const next: HostedGrantRecord = {
      ...grant,
      policy: input.policy,
      status: "active",
      approvedAt: at,
      expiresAt,
    };
    await this.store.updateGrant(next);
    if (input.policy === "item_standing" && grant.itemId) {
      await this.store.insertPolicy({
        id: `pol_${randomUUID()}`,
        orgId: input.orgId,
        clientId: grant.clientId,
        itemId: grant.itemId,
        folderId: null,
        environmentId: grant.environmentId,
        kind: "item_standing",
        createdAt: at,
      });
    }
    if (input.policy === "folder_standing") {
      await this.store.insertPolicy({
        id: `pol_${randomUUID()}`,
        orgId: input.orgId,
        clientId: grant.clientId,
        itemId: null,
        folderId: grant.folderId,
        environmentId: grant.environmentId,
        kind: "folder_standing",
        createdAt: at,
      });
    }
    const item = grant.itemId ? await this.store.getItem(grant.itemId) : undefined;
    await this.#audit(input.orgId, "grant", input.actor, item?.name ?? null, grant.clientId);
    assertSafePublicObject("approveGrant", next);
    return next;
  }

  /**
   * Finds the pending challenge whose code matches. A wrong code charges one attempt against the
   * most recently requested pending grant only, so typos cannot lock out every open approval.
   */
  async approveByCode(orgId: string, actor: string, role: MemberRole, code: string): Promise<HostedGrantRecord> {
    const pending = await this.store.listPendingGrants(orgId);
    const now = this.now();
    const candidates: { grant: HostedGrantRecord; ch: ApprovalChallengeRecord }[] = [];
    for (const grant of pending) {
      const ch = await this.store.getChallengeByGrantKind(grant.id, "code");
      if (ch && ch.kind === "code") candidates.push({ grant, ch });
    }
    let sawExpiredMatch = false;
    for (const { grant, ch } of candidates) {
      const [salt, expected] = ch.codeHash.split(":");
      if (!salt || !expected) continue;
      const actual = hashCode(code, salt);
      const ok =
        actual.length === expected.length &&
        timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
      if (!ok) continue;
      if (isPast(ch.expiresAt, now)) {
        sawExpiredMatch = true;
        continue;
      }
      if (ch.attempts >= 5) continue;
      await this.store.deleteChallenge(ch.id);
      return this.approveGrant({ orgId, grantId: grant.id, policy: "prompt", role, actor });
    }
    if (sawExpiredMatch) throw new HttpError(410, "Expired code");
    const newest = candidates.find(({ ch }) => !isPast(ch.expiresAt, now) && ch.attempts < 5);
    if (newest) {
      await this.store.updateChallenge({ ...newest.ch, attempts: newest.ch.attempts + 1 });
    }
    throw new HttpError(409, "Invalid or reused code");
  }

  async deleteOrg(orgId: string, actor: string, role: MemberRole, confirmName: string): Promise<void> {
    if (role !== "owner") throw new HttpError(403, "Only owners may delete the org");
    const org = await this.store.getOrg(orgId);
    if (!org) throw new HttpError(404, "Unknown org");
    const prod = await this.store.countProductionItems(orgId);
    if (prod > 0 && confirmName !== org.name) {
      throw new HttpError(400, "confirm_name must match the org name when production items exist");
    }
    logVaultEvent("delete_org", { orgId, actor });
    await this.store.deleteOrg(orgId);
  }

  /** Revokes every open grant for the (client, item) pair and drops the policies that would re-grant it. */
  async revokeGrant(orgId: string, actor: string, grantId: string): Promise<HostedGrantRecord> {
    const grant = await this.store.getGrant(grantId);
    if (!grant || grant.orgId !== orgId) throw new HttpError(404, "Unknown grant");
    const next = { ...grant, status: "revoked" as const };
    await this.store.updateGrant(next);
    const siblings = (await this.store.listGrants(orgId)).filter(
      (g) =>
        g.id !== grant.id &&
        g.clientId === grant.clientId &&
        g.itemId === grant.itemId &&
        (g.status === "active" || g.status === "pending"),
    );
    for (const g of siblings) {
      await this.store.updateGrant({ ...g, status: "revoked" });
    }
    const policies = await this.store.listPoliciesForClient(orgId, grant.clientId);
    for (const p of policies) {
      if (grant.itemId && p.itemId === grant.itemId) await this.store.deletePolicy(p.id);
      if (p.kind === "folder_standing" && p.environmentId === grant.environmentId) {
        if (p.folderId === grant.folderId) await this.store.deletePolicy(p.id);
      }
    }
    const item = grant.itemId ? await this.store.getItem(grant.itemId) : undefined;
    await this.#audit(orgId, "revoke", actor, item?.name ?? null, grant.clientId);
    return next;
  }

  async inbox(orgId: string): Promise<HostedGrantRecord[]> {
    return this.store.listPendingGrants(orgId);
  }

  async inboxGrantCards(orgId: string): Promise<
    Array<{
      id: string;
      status: string;
      policy: string;
      item_name: string | null;
      item_last4: string | null;
      client_name: string;
      task_description: string | null;
      created_at: string;
      approved_at: string | null;
    }>
  > {
    const all = await this.#settleExpired(await this.store.listGrants(orgId));
    const rows = all.filter(
      (g) => g.status === "pending" || (g.status === "active" && g.policy === "prompt"),
    );
    const cards = [];
    for (const g of rows) {
      const item = g.itemId ? await this.store.getItem(g.itemId) : undefined;
      const client = await this.store.getClient(g.clientId);
      cards.push({
        id: g.id,
        status: g.status,
        policy: g.policy,
        item_name: item?.name ?? null,
        item_last4: item?.last4 ?? null,
        client_name: client?.name ?? "agent",
        task_description: g.taskDescription,
        created_at: g.createdAt,
        approved_at: g.approvedAt,
      });
    }
    return cards;
  }

  async listClientGrants(orgId: string, clientId: string): Promise<HostedGrantRecord[]> {
    const all = await this.#settleExpired(await this.store.listGrants(orgId));
    return all.filter((g) => g.clientId === clientId);
  }

  async resolveTrusted(input: {
    orgId: string;
    clientId: string;
    itemName: string;
    environment: VaultEnvName;
  }): Promise<{ username: string | null; value: string; inject: string; name: string }> {
    const client = await this.#clientInOrg(input.orgId, input.clientId);
    if (client.kind !== "trusted") {
      throw new HttpError(403, "model tokens cannot resolve");
    }
    if (client.environment !== input.environment) {
      throw new HttpError(403, "Client cannot access this environment");
    }
    const env = await this.envFor(input.orgId, input.environment);
    const item = await this.store.getItemByName(env.id, normalizeItemName(input.itemName));
    if (!item) throw new HttpError(404, "Unknown item");
    await this.consumeActiveGrant(input.orgId, client.id, item.id);
    const decrypted = await this.decryptItem(input.orgId, item.id);
    await this.#audit(input.orgId, "inject", client.id, decrypted.name, client.id);
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
   * request has (or has not) left the process.
   */
  async prepareConnector(input: {
    orgId: string;
    clientId: string;
    itemName: string;
    environment: VaultEnvName;
    auditAfterSend?: boolean;
  }): Promise<{
    secret: string;
    username: string | null;
    last4: string;
    inject: string;
    allowedHosts: string[];
    name: string;
    kind: ItemKind;
    grantId: string;
    grantPolicy: string;
    itemId: string;
  }> {
    const client = await this.#clientInOrg(input.orgId, input.clientId);
    if (client.environment !== input.environment) {
      throw new HttpError(403, "Client cannot access this environment");
    }
    const env = await this.envFor(input.orgId, input.environment);
    const item = await this.store.getItemByName(env.id, normalizeItemName(input.itemName));
    if (!item) {
      throw await this.needItemError({
        orgId: input.orgId,
        clientId: input.clientId,
        environment: input.environment,
        itemName: input.itemName,
        host: "",
        alreadyLimited: false,
      });
    }
    const grant = await this.consumeActiveGrant(input.orgId, client.id, item.id);
    const decrypted = await this.decryptItem(input.orgId, item.id);
    if (!input.auditAfterSend) {
      await this.#audit(input.orgId, "inject", client.id, decrypted.name, client.id);
    }
    return {
      ...decrypted,
      grantId: grant.id,
      grantPolicy: grant.policy,
      itemId: item.id,
    };
  }

  /**
   * Audit truth for the connector: `inject` only after the credential left the process,
   * `inject_denied` when policy stopped it (host mismatch, blocked address), `inject_failed`
   * when the origin could not be reached.
   */
  async auditInject(orgId: string, clientId: string, itemName: string, outcome: InjectOutcome): Promise<void> {
    await this.#audit(orgId, outcome, clientId, itemName, clientId);
  }

  async reactivatePromptGrant(grantId: string | undefined): Promise<boolean> {
    if (!grantId) return false;
    return this.store.reactivateGrant(grantId);
  }

  async findStoredItem(orgId: string, environment: VaultEnvName, itemName: string) {
    const env = await this.envFor(orgId, environment);
    return this.store.getItemByName(env.id, normalizeItemName(itemName));
  }

  async updateItemMeta(input: {
    orgId: string;
    actor: string;
    itemId: string;
    username?: string;
    inject?: string;
    allowedHosts?: string[];
  }): Promise<ItemPublic> {
    return this.updateItem(input);
  }

  async updateItem(input: {
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
  }): Promise<ItemPublic> {
    const item = await this.store.getItem(input.itemId);
    if (!item) throw new HttpError(404, "Unknown item");
    const env = await this.store.getEnvironment(item.environmentId);
    if (!env) throw new HttpError(404, "Unknown environment");
    await this.#assertItemOrg(input.orgId, env.vaultId);
    const nextKind = input.kind ?? item.kind;
    const inject = input.inject ?? item.inject;
    const nextUsernameRaw = input.username !== undefined ? input.username : item.username;
    if (input.allowedHosts) this.#assertHosts(input.allowedHosts);
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
      nextEnv = await this.envFor(input.orgId, input.environment);
    }
    if (name !== item.name || nextEnv.id !== item.environmentId) {
      const existing = await this.store.getItemByName(nextEnv.id, name);
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
      updatedAt: nowIso(this.now()),
    };
    const newValue = input.value !== undefined && input.value.length > 0 ? input.value : undefined;
    const loginShapeChanged = itemStoresLoginPayload(item.kind) !== itemStoresLoginPayload(nextKind);
    const aadChanged = next.allowedHostsJson !== item.allowedHostsJson || next.inject !== item.inject;
    if (newValue !== undefined || loginShapeChanged || aadChanged) {
      if (newValue !== undefined) {
        if (Buffer.byteLength(newValue, "utf8") > MAX_ITEM_BYTES) {
          throw new HttpError(400, "Value exceeds 64KiB");
        }
      }
      const secret = newValue ?? (await this.decryptItem(input.orgId, item.id)).secret;
      const payload = itemStoresLoginPayload(nextKind)
        ? JSON.stringify({ username: next.username, password: secret })
        : secret;
      const dek = await this.dekForOrg(input.orgId);
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
      await this.store.updateItemEnvelope(item.id, {
        iv: envelope.iv,
        ciphertext: envelope.ciphertext,
        tag: envelope.tag,
        last4: last4(secret),
        updatedAt: next.updatedAt,
      });
    }
    await this.store.updateItemMeta(item.id, {
      name: next.name,
      kind: next.kind,
      environmentId: next.environmentId,
      username: next.username,
      inject: next.inject,
      allowedHostsJson: next.allowedHostsJson,
      updatedAt: next.updatedAt,
    });
    await this.#audit(input.orgId, "store", input.actor, next.name, null);
    const saved = await this.store.getItem(item.id);
    if (!saved) throw new HttpError(500, "Update failed");
    return this.#publicItem(nextEnv.name, saved);
  }

  async startSpotifyUserOauth(input: {
    orgId: string;
    userId: string;
    itemName: string;
    environment: VaultEnvName;
    clientId?: string;
    redirectUri?: string;
  }): Promise<{ authorize_url: string; redirect_uri: string }> {
    const env = await this.envFor(input.orgId, input.environment);
    const item = await this.store.getItemByName(env.id, normalizeSecretName(input.itemName));
    if (!item) throw new HttpError(404, "Unknown item");
    const clientId = (input.clientId ?? item.username ?? "").trim();
    if (!clientId) throw new HttpError(400, "Spotify Client ID is required (item username or client_id)");
    const redirectUri = chooseSpotifyRedirect(this.publicUrl, input.redirectUri);
    const codeVerifier = pkceVerifier();
    const state = sealOauthState(
      {
        orgId: input.orgId,
        userId: input.userId,
        itemId: item.id,
        itemName: item.name,
        environment: input.environment,
        clientId,
        redirectUri,
        codeVerifier,
        exp: this.now().getTime() + 10 * 60 * 1000,
      },
      this.#kek,
    );
    return {
      authorize_url: spotifyAuthorizeUrl({ clientId, redirectUri, state, codeVerifier }),
      redirect_uri: redirectUri,
    };
  }

  async finishSpotifyUserOauth(input: {
    orgId: string;
    userId: string;
    state: string;
    code: string;
    fetchImpl?: import("./connector.ts").ConnectorFetch;
  }): Promise<{ item_name: string; last4: string }> {
    const opened = openOauthState(input.state, this.#kek, this.now().getTime());
    if (opened.orgId !== input.orgId) throw new HttpError(403, "Spotify OAuth state is not for this org");
    const item = await this.store.getItem(opened.itemId);
    if (!item) throw new HttpError(404, "Unknown item");
    const decrypted = await this.decryptItem(input.orgId, item.id);
    const exchange = await mintSpotifyAccessToken({
      item: decrypted,
      clientId: opened.clientId,
      grantType: "authorization_code",
      code: input.code,
      redirectUri: opened.redirectUri,
      codeVerifier: opened.codeVerifier,
      fetchImpl: input.fetchImpl,
    });
    if (exchange.origin.status < 200 || exchange.origin.status >= 300) {
      throw new HttpError(
        exchange.origin.status >= 400 ? exchange.origin.status : 502,
        "Spotify code exchange failed",
      );
    }
    const refresh = exchange.minted.refreshToken;
    if (!refresh) {
      throw new HttpError(502, "Spotify did not return a refresh token");
    }
    const name = refreshItemName(opened.itemName);
    const envName = opened.environment === "production" ? "production" : "staging";
    const env = await this.envFor(input.orgId, envName);
    const existing = await this.store.getItemByName(env.id, name);
    let last: string;
    let refreshId = existing?.id ?? "";
    if (existing) {
      const rotated = await this.rotateItem({
        orgId: input.orgId,
        actor: input.userId,
        itemId: existing.id,
        value: refresh,
      });
      last = rotated.last4;
    } else {
      const created = await this.createItem({
        orgId: input.orgId,
        actor: input.userId,
        environment: envName,
        kind: "secret",
        name,
        value: refresh,
        username: opened.clientId,
        allowedHosts: [SPOTIFY_API_HOST, SPOTIFY_ACCOUNTS_HOST],
        inject: "refresh",
      });
      last = created.last4;
      refreshId = created.id;
    }
    const clients = await this.store.listClients(input.orgId);
    const at = nowIso(this.now());
    for (const client of clients) {
      if (client.kind !== "model" || client.revokedAt) continue;
      const have = await this.store.findItemPolicy(input.orgId, client.id, refreshId);
      if (have) continue;
      await this.store.insertPolicy({
        id: `pol_${randomUUID()}`,
        orgId: input.orgId,
        clientId: client.id,
        itemId: refreshId,
        folderId: null,
        environmentId: env.id,
        kind: "item_standing",
        createdAt: at,
      });
    }
    return { item_name: name, last4: last };
  }

  /** Validates a magic link and returns what approving it would do. No state change. */
  async previewMagic(orgId: string, token: string): Promise<{
    grant_id: string;
    client_name: string;
    item_name: string;
    item_last4: string;
    policy: string;
    task_description: string | null;
  }> {
    const grant = await this.#magicGrant(orgId, token);
    const item = grant.itemId ? await this.store.getItem(grant.itemId) : undefined;
    const client = await this.store.getClient(grant.clientId);
    const preview = {
      grant_id: grant.id,
      client_name: client?.name ?? "agent",
      item_name: item?.name ?? "",
      item_last4: item?.last4 ?? "",
      policy: "prompt",
      task_description: grant.taskDescription,
    };
    assertSafePublicObject("previewMagic", preview);
    return preview;
  }

  async approveMagic(orgId: string, actor: string, role: MemberRole, token: string): Promise<HostedGrantRecord> {
    const grant = await this.#magicGrant(orgId, token);
    const magic = await this.store.getChallengeByGrantKind(grant.id, "magic");
    if (!magic) throw new HttpError(410, "Expired link");
    await this.store.deleteChallenge(magic.id);
    return this.approveGrant({ orgId, grantId: grant.id, policy: "prompt", role, actor });
  }

  async #magicGrant(orgId: string, token: string): Promise<HostedGrantRecord> {
    if (!this.approvalHmac) throw new HttpError(500, "Magic links are not configured");
    const grantId = verifyApprovalToken(this.approvalHmac, token, this.now().getTime());
    const grant = await this.store.getGrant(grantId);
    if (!grant || grant.orgId !== orgId) throw new HttpError(404, "Unknown grant");
    if (grant.status !== "pending") throw new HttpError(410, "Expired link");
    const magic = await this.store.getChallengeByGrantKind(grantId, "magic");
    if (!magic || magic.codeHash !== token) throw new HttpError(410, "Expired link");
    return grant;
  }

  async consumeActiveGrant(orgId: string, clientId: string, itemId: string): Promise<HostedGrantRecord> {
    const grants = await this.#settleExpired(await this.store.listGrants(orgId));
    const at = this.now();
    const match = grants.find(
      (g) => g.clientId === clientId && g.itemId === itemId && g.status === "active",
    );
    if (!match) throw new HttpError(403, "inject_denied");
    if (match.policy === "prompt") {
      const ok = await this.store.consumeGrant(match.id, nowIso(at));
      if (!ok) throw new HttpError(403, "inject_denied");
      return { ...match, status: "consumed", consumedAt: nowIso(at) };
    }
    return match;
  }

  async decryptItem(orgId: string, itemId: string): Promise<{ secret: string; username: string | null; last4: string; inject: string; allowedHosts: string[]; name: string; kind: ItemKind }> {
    const item = await this.store.getItem(itemId);
    if (!item) throw new HttpError(404, "Unknown item");
    const dek = await this.dekForOrg(orgId);
    const plain = await this.#openItemEnvelope(orgId, item, dek);
    if (item.kind === "login") {
      const parsed: unknown = JSON.parse(plain);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as { password?: unknown }).password !== "string"
      ) {
        throw new HttpError(500, "Corrupt login item");
      }
      const password = (parsed as { password: string }).password;
      return {
        secret: password,
        username: item.username,
        last4: item.last4,
        inject: item.inject,
        allowedHosts: parseHosts(item.allowedHostsJson),
        name: item.name,
        kind: item.kind,
      };
    }
    return {
      secret: plain,
      username: item.username,
      last4: item.last4,
      inject: item.inject,
      allowedHosts: parseHosts(item.allowedHostsJson),
      name: item.name,
      kind: item.kind,
    };
  }

  /**
   * Decrypts with the item-bound AAD. Rows written before binding decrypt under the legacy
   * `orgId` AAD and are re-encrypted in place (migrate-on-read) without touching `updated_at`.
   */
  async #openItemEnvelope(orgId: string, item: ItemRecord, dek: Buffer): Promise<string> {
    const envelope = { iv: item.iv, ciphertext: item.ciphertext, tag: item.tag };
    const aad = itemAad({
      orgId,
      itemId: item.id,
      allowedHostsJson: item.allowedHostsJson,
      inject: item.inject,
    });
    try {
      return decrypt(envelope, dek, aad);
    } catch {
      // fall through to the legacy binding
    }
    const plain = decrypt(envelope, dek, legacyItemAad(orgId));
    const rebound = encrypt(plain, dek, aad);
    await this.store.updateItemEnvelope(item.id, {
      iv: rebound.iv,
      ciphertext: rebound.ciphertext,
      tag: rebound.tag,
      last4: item.last4,
      updatedAt: item.updatedAt,
    });
    return plain;
  }

  #assertHosts(hosts: string[]): void {
    if (hosts.length === 0) throw new HttpError(400, "allowed_hosts is required");
    for (const h of hosts) {
      assertAllowedHostname(h, [h]);
    }
  }

  async #assertItemOrg(orgId: string, vaultId: string): Promise<void> {
    const vaults = await this.store.listVaults(orgId);
    if (!vaults.some((v) => v.id === vaultId)) throw new HttpError(404, "Unknown item");
  }

  async #clientInOrg(orgId: string, clientId: string): Promise<ClientRecord> {
    const c = await this.store.getClient(clientId);
    if (!c || c.orgId !== orgId) throw new HttpError(404, "Unknown client");
    return c;
  }

  async #standingFor(
    orgId: string,
    clientId: string,
    item: { id: string; folderId: string | null; environmentId: string },
  ) {
    const itemPol = await this.store.findItemPolicy(orgId, clientId, item.id);
    if (itemPol) return itemPol;
    return this.store.findFolderPolicy(orgId, clientId, item.folderId, item.environmentId);
  }

  #publicItem(environment: VaultEnvName, item: {
    id: string;
    name: string;
    kind: ItemKind;
    last4: string;
    username: string | null;
    inject: string;
    allowedHostsJson: string;
    folderId: string | null;
  }): ItemPublic {
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
    };
    assertSafePublicObject("item", pub);
    return pub;
  }

  /**
   * The org an operator session acts in. `preferredOrgId` (the session's `active_org_id` from the
   * switcher) wins when the user is still a member of it; otherwise the first membership, and a
   * fresh personal org for a user with none.
   */
  async ensureVaultOrgForUser(userId: string, preferredOrgId?: string | null): Promise<{ orgId: string; role: MemberRole }> {
    const existing = await this.store.listMembershipsForUser(userId);
    if (preferredOrgId) {
      const preferred = existing.find((m) => m.orgId === preferredOrgId);
      if (preferred) return { orgId: preferred.orgId, role: preferred.role };
    }
    if (existing[0]) return { orgId: existing[0].orgId, role: existing[0].role };
    const orgId = `org_${userId.replace(/^usr_/, "")}`;
    try {
      await this.#provisionOrg(orgId, "workspace", userId);
    } catch (err) {
      if (!(err instanceof StoreConflictError) && !isUniqueViolation(err)) {
        const again = await this.store.listMembershipsForUser(userId);
        if (again[0]) return { orgId: again[0].orgId, role: again[0].role };
        throw err;
      }
      if (!(await this.store.getMember(orgId, userId))) {
        await this.store.insertMember({ orgId, userId, role: "owner" });
      }
    }
    const again = await this.store.listMembershipsForUser(userId);
    if (again[0]) return { orgId: again[0].orgId, role: again[0].role };
    const role = await this.requireMember(orgId, userId);
    return { orgId, role };
  }

  async recordAccessEvent(input: Omit<AccessEventRecord, "id" | "revokedAt">): Promise<void> {
    await this.store.insertAccessEvent({
      id: `aev_${randomUUID()}`,
      ...input,
      revokedAt: null,
    });
  }

  async writeAudit(
    orgId: string,
    action: string,
    actor: string,
    itemName: string | null,
    clientId: string | null,
  ): Promise<void> {
    await this.#audit(orgId, action, actor, itemName, clientId);
  }

  async listAccess(orgId: string, currentSessionHash?: string) {
    const [members, clients, storedGrants, sessions, audit, events] = await Promise.all([
      this.store.listMembers(orgId),
      this.store.listClients(orgId),
      this.store.listGrants(orgId),
      this.store.listOperatorSessions(orgId),
      this.store.listAudit(orgId, 200, { action: "inject" }),
      this.store.listAccessEvents(orgId, 200),
    ]);
    const grants = await this.#settleExpired(storedGrants);
    const users = await Promise.all(members.map((m) => this.store.getUser(m.userId)));
    const operators = members.map((m, i) => ({
      user_id: m.userId,
      role: m.role,
      email: users[i]?.email ?? "",
    }));
    const clientRows = await Promise.all(
      clients.map(async (c) => {
        const actor = c.consentedByUserId ? await this.store.getUser(c.consentedByUserId) : undefined;
        const usage = clientUsage(c, events, audit, c.id);
        return {
          id: c.id,
          name: c.name,
          kind: c.oauthClientId ? "oauth" : c.kind,
          environment: c.environment,
          status: c.revokedAt ? "revoked" : "active",
          created_at: usage.created_at,
          first_access_at: usage.first_access_at,
          last_access_at: usage.last_access_at,
          last_token_at: c.lastTokenAt,
          last_seen_at: c.lastSeenAt,
          fetched: usage.fetched,
          last4: c.last4,
          consented_by_email: actor?.email ?? null,
        };
      }),
    );
    const itemNames = new Map<string, string>();
    const clientNames = new Map(clients.map((c) => [c.id, c.name]));
    const grantRows = [];
    for (const g of grants) {
      let itemName = "";
      if (g.itemId) {
        const cached = itemNames.get(g.itemId);
        if (cached) itemName = cached;
        else {
          const item = await this.store.getItem(g.itemId);
          itemName = item?.name ?? "";
          if (g.itemId) itemNames.set(g.itemId, itemName);
        }
      }
      const usage = grantUsage(g, audit, g.clientId, itemName);
      grantRows.push({
        id: g.id,
        item_name: itemName,
        client_id: g.clientId,
        client_name: clientNames.get(g.clientId) ?? g.clientId,
        status: g.status,
        created_at: usage.created_at,
        first_access_at: usage.first_access_at,
        last_access_at: usage.last_access_at,
        approved_at: g.approvedAt,
        fetched: usage.fetched,
      });
    }
    const sessionRows = sessions.map((s) => {
      const usage = sessionUsage(s);
      return {
        id: s.idHash.slice(0, 12),
        created_at: usage.created_at,
        first_access_at: usage.first_access_at,
        last_access_at: usage.last_access_at,
        last_seen_at: s.lastSeenAt,
        current: Boolean(currentSessionHash && s.idHash === currentSessionHash),
        hash: s.idHash,
      };
    });
    const snap = {
      operators,
      clients: clientRows,
      grants: grantRows,
      sessions: sessionRows.map(({ hash: _h, ...rest }) => rest),
      sessionHashes: sessionRows,
    };
    assertSafePublicObject("listAccess", {
      operators: snap.operators,
      clients: snap.clients,
      grants: snap.grants,
      sessions: snap.sessions,
    });
    return snap;
  }

  async revokeClient(orgId: string, actor: string, clientId: string): Promise<void> {
    const client = await this.store.getClient(clientId);
    if (!client || client.orgId !== orgId) throw new HttpError(404, "Unknown client");
    const at = nowIso(this.now());
    await this.store.setClientRevoked(clientId, at);
    await this.store.revokeAccessEventsForClient(clientId, at);
    const grants = await this.store.listGrants(orgId);
    for (const g of grants) {
      if (g.clientId === clientId && (g.status === "active" || g.status === "pending")) {
        await this.store.updateGrant({ ...g, status: "revoked" });
      }
    }
    await destroyOidcPayloadsForClient(this.store, client);
    await this.#audit(orgId, "client_revoked", actor, null, clientId);
  }

  /**
   * `sessionId` is the 12+ character hash prefix shown in Access (or the full hash). Members may
   * revoke their own sessions; only owners may revoke another member's.
   */
  async revokeSession(
    orgId: string,
    actor: { userId: string; role: MemberRole; sessionHash: string },
    sessionId: string,
  ): Promise<void> {
    if (sessionId.length < SESSION_ID_MIN_CHARS || !/^[0-9a-f]+$/i.test(sessionId)) {
      throw new HttpError(400, "Session id must be at least 12 hex characters");
    }
    const sessions = await this.store.listOperatorSessions(orgId);
    const matches = sessions.filter((s) => s.idHash.startsWith(sessionId.toLowerCase()));
    const match = matches[0];
    if (!match || matches.length > 1) throw new HttpError(404, "Unknown session");
    if (match.idHash === actor.sessionHash) throw new HttpError(400, "cannot_revoke_current");
    if (match.userId !== actor.userId && actor.role !== "owner") {
      throw new HttpError(403, "Only owners may revoke another member's session");
    }
    await this.store.deleteSession(match.idHash);
  }

  async #recordMachineIssue(row: ClientRecord, plaintext: string): Promise<void> {
    const at = nowIso(this.now());
    await this.store.setClientLastTokenAt(row.id, at);
    await this.recordAccessEvent({
      orgId: row.orgId,
      clientId: row.id,
      actorUserId: null,
      kind: "machine",
      jtiHash: hashSecret(plaintext),
      issuedAt: at,
      expiresAt: null,
    });
    await this.writeAudit(row.orgId, "token_issued", row.id, null, row.id);
  }

  async #audit(
    orgId: string,
    action: string,
    actor: string,
    itemName: string | null,
    clientId: string | null,
  ): Promise<void> {
    await this.store.insertAudit({
      id: `aud_${randomUUID()}`,
      orgId,
      action,
      actor,
      itemName,
      clientId,
      at: nowIso(this.now()),
    });
  }
}

export function mintApprovalToken(hmac: Buffer, grantId: string, expMs: number): string {
  const body = Buffer.from(JSON.stringify({ grantId, exp: expMs })).toString("base64url");
  const sig = createHmac("sha256", hmac).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyApprovalToken(hmac: Buffer, token: string, nowMs: number): string {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new HttpError(410, "Invalid link");
  const expected = createHmac("sha256", hmac).update(body).digest("base64url");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    throw new HttpError(410, "Invalid link");
  }
  const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new HttpError(410, "Invalid link");
  const rec = parsed as { grantId?: unknown; exp?: unknown };
  if (typeof rec.grantId !== "string" || typeof rec.exp !== "number") {
    throw new HttpError(410, "Invalid link");
  }
  if (rec.exp < nowMs) throw new HttpError(410, "Expired link");
  return rec.grantId;
}

export { MAGIC_TTL_MS };
