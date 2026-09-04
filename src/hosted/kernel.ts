import { createHash, randomBytes, randomUUID } from "node:crypto";
import { decrypt, encrypt } from "../crypto.ts";
import { resolvePublicOrigin } from "../brand.ts";
import { last4, normalizeSecretName } from "../ids.ts";
import { assertSafePublicObject } from "../redact.ts";
import {
  emptyClientFields,
  publicGrantScope,
  unscopedFields,
  type AccessEventRecord,
  type ClientRecord,
  type FindItemsResult,
  type HostedGrantRecord,
  type ItemKind,
  type ItemPublic,
  type ItemRecord,
  type MemberRole,
  type VaultEnvName,
} from "../hosted-types.ts";
import { isUniqueViolation, StoreConflictError } from "../store/conflict.ts";
import type { VaultStore } from "../store/types.ts";
import { deployPlaneAllowsEnvironment, environmentsForDeployPlane } from "./deploy-plane.ts";
import { HttpError } from "./errors.ts";
import { itemAad, legacyItemAad } from "./item-aad.ts";
import { generateDek, unwrapDek, wrapDek } from "./kek.ts";
import {
  approveByCode,
  approveGrant,
  approveMagic,
  assertMemberEmail,
  consumeActiveGrant,
  inboxGrantCards,
  listClientGrants,
  MAGIC_TTL_MS,
  mintApprovalToken,
  previewMagic,
  requestGrant,
  revokeGrant,
  settleExpired,
  standingFor,
  verifyApprovalToken,
  type ApproveGrantInput,
  type ConnectorCall,
  type GrantHost,
  type InboxGrantCard,
  type MagicPreview,
  type RequestGrantInput,
  type RequestGrantResult,
} from "./kernel-grants.ts";
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
import type { ConnectorFetch } from "./connector.ts";
import { exchangeAuthorizationCode, refreshItemName } from "./providers/oauth.ts";
import { providerById } from "./providers/registry.ts";
import type { Provider, ProviderId } from "./providers/types.ts";
import { authorizeUrl, chooseRedirect, openOauthState, pkceVerifier, sealOauthState } from "./providers/user-oauth.ts";

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
      assertPlanLimit: (orgId, kind) => this.assertPlanLimit(orgId, kind),
      assertPlane: (name) => this.#assertPlane(name),
      standingFor: (orgId, clientId, item) => standingFor(this.#grantHost(), orgId, clientId, item),
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

  async lookupTrustedToken(token: string): Promise<ClientRecord | undefined> {
    return this.store.findClientByHashedSecret(hashSecret(token));
  }

  /** See `kernel-grants.ts` `requestGrant`: one open grant per (client, item), limiter counted once. */
  async requestGrant(input: RequestGrantInput): Promise<RequestGrantResult> {
    return requestGrant(this.#grantHost(), input);
  }

  /** REST boundary check for `operator_email`: only this org's members may be addressed. */
  async assertMemberEmail(orgId: string, email: string): Promise<string> {
    return assertMemberEmail(this.#grantHost(), orgId, email);
  }


  async approveGrant(input: ApproveGrantInput): Promise<HostedGrantRecord> {
    return approveGrant(this.#grantHost(), input);
  }

  /** A wrong code charges one attempt against the newest pending grant only (D14). */
  async approveByCode(orgId: string, actor: string, role: MemberRole, code: string): Promise<HostedGrantRecord> {
    return approveByCode(this.#grantHost(), orgId, actor, role, code);
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
    return revokeGrant(this.#grantHost(), orgId, actor, grantId);
  }


  async inbox(orgId: string): Promise<HostedGrantRecord[]> {
    return this.store.listPendingGrants(orgId);
  }

  async inboxGrantCards(orgId: string): Promise<InboxGrantCard[]> {
    return inboxGrantCards(this.#grantHost(), orgId);
  }

  async listClientGrants(orgId: string, clientId: string): Promise<HostedGrantRecord[]> {
    return listClientGrants(this.#grantHost(), orgId, clientId);
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
   * request has (or has not) left the process. With `request`, a scoped grant must admit the
   * call (method, host, path prefix) or this is 403 `scope_denied` before anything is decrypted.
   */
  async prepareConnector(input: {
    orgId: string;
    clientId: string;
    itemName: string;
    environment: VaultEnvName;
    auditAfterSend?: boolean;
    request?: ConnectorCall;
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
    const grant = await this.consumeActiveGrant(input.orgId, client.id, item.id, input.request);
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

  /* ---- provider user connect (authorization_code) ---- */

  /** A registry provider with a user connect flow; 404 for unknown ids, 400 when it has no authorize URL. */
  #connectProvider(providerId: string): Provider {
    const provider = providerById(providerId);
    if (!provider) throw new HttpError(404, "Unknown provider", { provider: providerId });
    if (!provider.authorizeUrl) {
      throw new HttpError(400, `${provider.displayName} has no user connect flow`, { provider: provider.id });
    }
    return provider;
  }

  /**
   * Starts the user connect for `providerId` against a stored client-secret item. The sealed
   * state carries the provider id, so the callback rejects a state minted for another provider.
   * `agentClientId` names the one model client that gets an `item_standing` policy on the
   * refresh item after connect; without it the operator approves normally.
   */
  async startProviderUserOauth(input: {
    providerId: string;
    orgId: string;
    userId: string;
    itemName: string;
    environment: VaultEnvName;
    clientId?: string;
    redirectUri?: string;
    agentClientId?: string;
  }): Promise<{ authorize_url: string; redirect_uri: string; provider: ProviderId }> {
    const provider = this.#connectProvider(input.providerId);
    const env = await this.envFor(input.orgId, input.environment);
    const item = await this.store.getItemByName(env.id, normalizeItemName(input.itemName));
    if (!item) throw new HttpError(404, "Unknown item");
    const clientId = (input.clientId ?? item.username ?? "").trim();
    if (!clientId) {
      throw new HttpError(400, `${provider.displayName} Client ID is required (item username or client_id)`);
    }
    const agentClientId = input.agentClientId?.trim() || undefined;
    if (agentClientId) {
      const agent = await this.#clientInOrg(input.orgId, agentClientId);
      if (agent.kind !== "model" || agent.revokedAt) throw new HttpError(400, "agent_client_id must be an active model client");
    }
    const redirectUri = chooseRedirect(provider, this.publicUrl, input.redirectUri);
    const codeVerifier = pkceVerifier();
    const state = sealOauthState(
      {
        providerId: provider.id,
        orgId: input.orgId,
        userId: input.userId,
        itemId: item.id,
        itemName: item.name,
        environment: input.environment,
        clientId,
        redirectUri,
        codeVerifier,
        exp: this.now().getTime() + 10 * 60 * 1000,
        ...(agentClientId ? { agentClientId } : {}),
      },
      this.#kek,
    );
    return {
      authorize_url: authorizeUrl(provider, { clientId, redirectUri, state, codeVerifier }),
      redirect_uri: redirectUri,
      provider: provider.id,
    };
  }

  /**
   * Exchanges the callback code with the client-secret item and stores the refresh token as
   * `<ITEM>_REFRESH` (`inject: refresh`, allowed on the provider's API and token hosts). When
   * `providerId` is given (the callback route's `:provider`) the state must have been minted for it.
   */
  async finishProviderUserOauth(input: {
    providerId?: string;
    orgId: string;
    userId: string;
    state: string;
    code: string;
    fetchImpl?: ConnectorFetch;
  }): Promise<{ item_name: string; last4: string; provider: ProviderId }> {
    const opened = openOauthState(input.state, this.#kek, this.now().getTime());
    if (input.providerId !== undefined && opened.providerId !== input.providerId) {
      throw new HttpError(400, "OAuth state is for another provider", { provider: opened.providerId });
    }
    const provider = this.#connectProvider(opened.providerId);
    if (opened.orgId !== input.orgId) throw new HttpError(403, "OAuth state is not for this org");
    const item = await this.store.getItem(opened.itemId);
    if (!item) throw new HttpError(404, "Unknown item");
    const decrypted = await this.decryptItem(input.orgId, item.id);
    const exchange = await exchangeAuthorizationCode(
      provider,
      decrypted,
      {
        clientId: opened.clientId,
        code: input.code,
        redirectUri: opened.redirectUri,
        codeVerifier: opened.codeVerifier,
      },
      { fetchImpl: input.fetchImpl },
    );
    if (exchange.origin.status < 200 || exchange.origin.status >= 300) {
      throw new HttpError(
        exchange.origin.status >= 400 ? exchange.origin.status : 502,
        `${provider.displayName} code exchange failed`,
      );
    }
    const refresh = exchange.minted.refreshToken;
    if (!refresh) {
      throw new HttpError(502, `${provider.displayName} did not return a refresh token`);
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
        allowedHosts: [...new Set([...provider.apiHosts, provider.tokenHost])],
        inject: "refresh",
      });
      last = created.last4;
      refreshId = created.id;
    }
    if (opened.agentClientId) {
      const agent = await this.#clientInOrg(input.orgId, opened.agentClientId);
      const have = await this.store.findItemPolicy(input.orgId, agent.id, refreshId);
      if (agent.kind === "model" && !agent.revokedAt && !have) {
        await this.store.insertPolicy({
          id: `pol_${randomUUID()}`,
          orgId: input.orgId,
          clientId: agent.id,
          itemId: refreshId,
          folderId: null,
          environmentId: env.id,
          kind: "item_standing",
          createdAt: nowIso(this.now()),
          ...unscopedFields(),
          expiresAt: null,
        });
      }
    }
    return { item_name: name, last4: last, provider: provider.id };
  }

  /** Validates a magic link and returns what approving it would do. No state change. */
  async previewMagic(orgId: string, token: string): Promise<MagicPreview> {
    return previewMagic(this.#grantHost(), orgId, token);
  }

  async approveMagic(orgId: string, actor: string, role: MemberRole, token: string): Promise<HostedGrantRecord> {
    return approveMagic(this.#grantHost(), orgId, actor, role, token);
  }

  /** See `kernel-grants.ts` `consumeActiveGrant`: with `call`, the grant's scope must admit it. */
  async consumeActiveGrant(
    orgId: string,
    clientId: string,
    itemId: string,
    call?: ConnectorCall,
  ): Promise<HostedGrantRecord> {
    return consumeActiveGrant(this.#grantHost(), orgId, clientId, itemId, call);
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

  #grantHost(): GrantHost {
    return {
      store: this.store,
      now: this.now,
      publicUrl: this.publicUrl,
      approvalHmac: this.approvalHmac,
      sendEmail: this.sendEmail,
      limiter: this.limiter,
      envFor: (orgId, name) => this.envFor(orgId, name),
      clientInOrg: (orgId, clientId) => this.#clientInOrg(orgId, clientId),
      needItemError: (input) => this.needItemError(input),
      audit: (orgId, action, actor, itemName, clientId) => this.#audit(orgId, action, actor, itemName, clientId),
    };
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
    const grants = await settleExpired(this.#grantHost(), storedGrants);
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
        policy: g.policy,
        created_at: usage.created_at,
        first_access_at: usage.first_access_at,
        last_access_at: usage.last_access_at,
        approved_at: g.approvedAt,
        expires_at: g.expiresAt,
        grant_scope: publicGrantScope(g),
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

export { MAGIC_TTL_MS, mintApprovalToken, verifyApprovalToken };
