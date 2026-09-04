/**
 * The hosted kernel: one object per plane that owns the store, the KEK, the clock, and the
 * notifier, and exposes every operation the HTTP and MCP surfaces call. Org, item, client,
 * grant, need, member, and provider-connect logic live in sibling `kernel-*.ts` modules that
 * take a host object; this class builds those hosts and keeps the public method names stable.
 */
import { randomUUID } from "node:crypto";
import { resolvePublicOrigin } from "../brand.ts";
import type { Envelope } from "../crypto.ts";
import { assertSafePublicObject } from "../redact.ts";
import type {
  AccessEventRecord,
  ClientRecord,
  FindItemsResult,
  HostedGrantRecord,
  ItemKind,
  ItemPublic,
  MemberRole,
  VaultEnvName,
} from "../hosted-types.ts";
import type { VaultStore } from "../store/types.ts";
import { deployPlaneAllowsEnvironment } from "./deploy-plane.ts";
import { HttpError } from "./errors.ts";
import { unwrapDek, wrapDek } from "./kek.ts";
import * as clients from "./kernel-clients.ts";
import * as connect from "./kernel-connect.ts";
import { MAGIC_TTL_MS, mintApprovalToken, verifyApprovalToken } from "./kernel-grant-approval.ts";
import * as grants from "./kernel-grants.ts";
import * as items from "./kernel-items.ts";
import * as members from "./kernel-members.ts";
import * as orgs from "./kernel-orgs.ts";
import * as needs from "./need-ops.ts";
import { assertWithinLimit, monthStartIso, planLimits, type OrgUsageKind, type PlanLimitKind, type PlanLimits, type PlanReport, type PlanUsage } from "./plan-limits.ts";
import { IpWindowLimiter } from "./identity-limiter.ts";
import { OrgRateLimiter } from "./rate-limit.ts";
import type { IdentityRotateResult } from "./identity-keys.ts";
import { openOauthState, sealOauthState } from "./providers/user-oauth.ts";

export { BOOTSTRAP_ORG_ID, BOOTSTRAP_USER_ID } from "./kernel-orgs.ts";
export { MAGIC_TTL_MS, mintApprovalToken, verifyApprovalToken };
export type { PreparedItem } from "./kernel-items.ts";

export type HostedKernelOpts = {
  store: VaultStore;
  kek: Buffer;
  /** The KEK a rotation is leaving (`VAULT_KEK_PREVIOUS`); DEKs still under it are re-wrapped on read. */
  previousKek?: Buffer;
  now?: () => Date;
  sendEmail?: (to: string, subject: string, html: string) => Promise<void>;
  publicUrl?: string;
  approvalHmac?: Buffer;
  deployPlane?: "staging" | "production";
  limiter?: OrgRateLimiter;
  /** Plan limits (3.9). Defaults to the free tier with the `VAULT_PLAN_LIMITS_JSON` override. */
  planLimits?: PlanLimits;
};

export type InjectOutcome = "inject" | "inject_denied" | "inject_failed";

export class HostedKernel {
  readonly store: VaultStore;
  readonly #kek: Buffer;
  readonly #previousKek: Buffer | undefined;
  readonly now: () => Date;
  readonly sendEmail: HostedKernelOpts["sendEmail"];
  readonly publicUrl: string;
  readonly approvalHmac: Buffer | undefined;
  readonly deployPlane: "staging" | "production";
  readonly limiter: OrgRateLimiter;
  readonly planLimits: PlanLimits;
  /** Invite spam bounds (`kernel-members.ts`), per inviting account and per client address. */
  readonly inviteLimiter = new IpWindowLimiter();

  constructor(opts: HostedKernelOpts) {
    this.store = opts.store;
    this.#kek = opts.kek;
    this.#previousKek = opts.previousKek;
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

  /* ---- orgs and the KEK (kernel-orgs.ts) ---- */

  async createOrg(name: string, userId: string): Promise<{ orgId: string }> {
    return orgs.createOrg(this.#orgHost(), name, userId);
  }

  async ensureBootstrapOperator(): Promise<{ orgId: string; userId: string; role: MemberRole }> {
    return orgs.ensureBootstrapOperator(this.#orgHost());
  }

  /** See `kernel-orgs.ts` `ensureVaultOrgForUser`: the preferred org when still a member, else the first, else a fresh one. */
  async ensureVaultOrgForUser(userId: string, preferredOrgId?: string | null): Promise<orgs.Membership> {
    return orgs.ensureVaultOrgForUser(this.#orgHost(), userId, preferredOrgId);
  }

  async deleteOrg(orgId: string, actor: string, role: MemberRole, confirmName: string): Promise<void> {
    return orgs.deleteOrg(this.#orgHost(), orgId, actor, role, confirmName);
  }

  async requireMember(orgId: string, userId: string): Promise<MemberRole> {
    return orgs.requireMember(this.#orgHost(), orgId, userId);
  }

  async dekForOrg(orgId: string): Promise<Buffer> {
    return orgs.dekForOrg(this.#orgHost(), orgId);
  }

  async rotateKek(oldKek: Buffer, newKek: Buffer): Promise<{ rewrapped: number; skipped: number; identity: IdentityRotateResult }> {
    return orgs.rotateKek(this.#orgHost(), oldKek, newKek);
  }

  async addMember(orgId: string, userId: string, role: MemberRole): Promise<void> {
    await this.store.insertMember({ orgId, userId, role, joinedAt: this.now().toISOString() });
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

  async createFolder(orgId: string, environment: VaultEnvName, name: string): Promise<{ id: string; name: string }> {
    const env = await this.envFor(orgId, environment);
    const existing = await this.store.getFolderByName(env.id, name);
    if (existing) throw new HttpError(409, "Folder already exists");
    const id = `fld_${randomUUID()}`;
    await this.store.insertFolder({ id, environmentId: env.id, name });
    return { id, name };
  }

  /* ---- team (kernel-members.ts) ---- */

  async listTeam(orgId: string): Promise<members.TeamSnapshot> {
    const snap = await members.listTeam(this.#memberHost(), orgId);
    assertSafePublicObject("listTeam", snap);
    return snap;
  }

  async inviteMember(input: {
    orgId: string;
    actorUserId: string;
    actorRole: MemberRole;
    email: string;
    role: MemberRole;
    ip: string;
  }): Promise<{ invite: members.PendingInvite; accept_url: string; email_sent: boolean }> {
    return members.inviteMember(this.#memberHost(), input);
  }

  /** `POST /api/orgs`: a validated name and the per-user `orgs` plan limit, then `createOrg`. */
  async createOrgForUser(name: string, userId: string): Promise<{ orgId: string }> {
    const clean = members.assertOrgName(name);
    await members.assertMayCreateOrg(this.#memberHost(), userId);
    return this.createOrg(clean, userId);
  }

  async cancelInvite(input: { orgId: string; actorUserId: string; actorRole: MemberRole; inviteId: string }): Promise<void> {
    return members.cancelInvite(this.#memberHost(), input);
  }

  async updateMemberRole(input: {
    orgId: string;
    actorUserId: string;
    actorRole: MemberRole;
    userId: string;
    role: MemberRole;
  }): Promise<members.TeamMember> {
    return members.updateMemberRole(this.#memberHost(), input);
  }

  async removeMember(input: { orgId: string; actorUserId: string; actorRole: MemberRole; userId: string }): Promise<void> {
    return members.removeMember(this.#memberHost(), input);
  }

  async previewInvite(token: string): Promise<members.InvitePreview> {
    return members.previewInvite(this.#memberHost(), token);
  }

  async acceptInvite(input: { userId: string; email: string; token: string }): Promise<{ org_id: string; org_name: string; role: MemberRole }> {
    return members.acceptInvite(this.#memberHost(), input);
  }

  async listOrgsForUser(userId: string, activeOrgId: string): Promise<members.OrgSummary[]> {
    return members.listOrgsForUser(this.#memberHost(), userId, activeOrgId);
  }

  async setActiveOrg(input: { userId: string; sessionHash: string; orgId: string }): Promise<members.OrgSummary> {
    return members.setActiveOrg(this.#memberHost(), input);
  }

  /* ---- plan limits (3.9) ---- */

  /** Current usage for one limit kind. `credentials` spans every environment, not just the plane. */
  async planUsageFor(orgId: string, kind: OrgUsageKind): Promise<number> {
    switch (kind) {
      case "credentials":
        return this.store.countItemsForOrg(orgId);
      case "agents":
        return (await this.store.listClients(orgId)).filter((c) => !c.revokedAt).length;
      case "members":
        return members.seatsInUse(this.#memberHost(), orgId);
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
    // `orgs` is counted per user (`createOrgForUser`), never against one org.
    if (kind === "orgs") throw new Error("orgs is a per-user limit; use createOrgForUser");
    assertWithinLimit(kind, await this.planUsageFor(orgId, kind), this.planLimits);
  }

  /** Monthly `http_request` budget; `runHttpRequest` calls it before `prepareConnector`. */
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

  /* ---- items (kernel-items.ts) ---- */

  async createItem(input: items.CreateItemInput): Promise<ItemPublic> {
    return items.createItem(this.#itemHost(), input);
  }

  async rotateItem(input: items.RotateItemInput): Promise<ItemPublic> {
    return items.rotateItem(this.#itemHost(), input);
  }

  async updateItem(input: items.UpdateItemInput): Promise<ItemPublic> {
    return items.updateItem(this.#itemHost(), input);
  }

  async deleteItem(orgId: string, actor: string, itemId: string): Promise<void> {
    return items.deleteItem(this.#itemHost(), orgId, actor, itemId);
  }

  async listItems(orgId: string, environment: VaultEnvName): Promise<ItemPublic[]> {
    return items.listItems(this.#itemHost(), orgId, environment);
  }

  /** Items in every vault environment this deploy plane may serve. */
  async listItemsOnPlane(orgId: string): Promise<ItemPublic[]> {
    return items.listItemsOnPlane(this.#itemHost(), orgId);
  }

  async decryptItem(orgId: string, itemId: string): Promise<items.DecryptedItem> {
    return items.decryptItem(this.#itemHost(), orgId, itemId);
  }

  /** Boot-time one-shot: binds every item envelope still under the legacy `orgId` AAD. See `kernel-items.ts`. */
  async rebindLegacyItems(): Promise<items.RebindResult> {
    return items.rebindLegacyItems(this.#itemHost());
  }

  async findStoredItem(orgId: string, environment: VaultEnvName, itemName: string) {
    return items.findStoredItem(this.#itemHost(), orgId, environment, itemName);
  }

  /** `POST /runtime/resolve`: a trusted process spends its grant and gets the plaintext. */
  async resolveTrusted(input: items.ResolveTrustedInput): Promise<{ username: string | null; value: string; inject: string; name: string }> {
    return items.resolveTrusted(this.#itemHost(), input);
  }

  /** See `kernel-items.ts` `prepareConnector`: the plaintext plus the grant that admitted the call. */
  async prepareConnector(input: items.PrepareConnectorInput): Promise<items.PreparedItem> {
    return items.prepareConnector(this.#itemHost(), input);
  }

  /**
   * Audit truth for the connector: `inject` only after the credential left the process,
   * `inject_denied` when policy stopped it (host mismatch, blocked address), `inject_failed`
   * when the origin could not be reached.
   */
  async auditInject(orgId: string, clientId: string, itemName: string, outcome: InjectOutcome): Promise<void> {
    await this.#audit(orgId, outcome, clientId, itemName, clientId);
  }

  /* ---- needs (need-ops.ts) ---- */

  async findItems(input: {
    orgId: string;
    clientId: string;
    environment: VaultEnvName;
    itemName?: string;
    host?: string;
    taskDescription?: string;
  }): Promise<FindItemsResult> {
    return needs.findItems(this.#needHost(), input);
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
    return needs.ensureNeedItem(this.#needHost(), input);
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
    return needs.needItemError(this.#needHost(), input);
  }

  async getNeed(id: string) {
    return needs.getNeed(this.#needHost(), id);
  }

  async listInboxNeeds(orgId: string) {
    return needs.listInboxNeeds(this.#needHost(), orgId);
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
    return needs.fulfillNeed(this.#needHost(), input);
  }

  /* ---- clients (kernel-clients.ts) ---- */

  async createTrustedClient(input: clients.CreateTrustedClientInput): Promise<{ client: ClientRecord; plaintext: string }> {
    return clients.createTrustedClient(this.#clientHost(), input);
  }

  async createModelClient(input: clients.CreateModelClientInput): Promise<{ client: ClientRecord; plaintext?: string }> {
    return clients.createModelClient(this.#clientHost(), input);
  }

  /** Reuses the live model client for this OAuth id. Revoked clients are never resurrected. */
  async ensureModelClient(input: clients.EnsureModelClientInput): Promise<ClientRecord> {
    return clients.ensureModelClient(this.#clientHost(), input);
  }

  async rotateClient(orgId: string, actor: string, clientId: string): Promise<{ token: string; client_id: string }> {
    return clients.rotateClient(this.#clientHost(), orgId, actor, clientId);
  }

  /** Operator-only. Moves a client (including OAuth-issued ones) to another vault environment. */
  async setClientEnvironment(orgId: string, actor: string, clientId: string, environment: VaultEnvName): Promise<ClientRecord> {
    return clients.setClientEnvironment(this.#clientHost(), orgId, actor, clientId, environment);
  }

  async lookupTrustedToken(token: string): Promise<ClientRecord | undefined> {
    return clients.lookupTrustedToken(this.#clientHost(), token);
  }

  async revokeClient(orgId: string, actor: string, clientId: string): Promise<void> {
    return clients.revokeClient(this.#clientHost(), orgId, actor, clientId);
  }

  /** See `kernel-clients.ts` `revokeSession`: 12+ hex chars; owners may revoke another member's. */
  async revokeSession(orgId: string, actor: clients.SessionActor, sessionId: string): Promise<void> {
    return clients.revokeSession(this.#clientHost(), orgId, actor, sessionId);
  }

  async listAccess(orgId: string, currentSessionHash?: string) {
    return clients.listAccess(this.#clientHost(), orgId, currentSessionHash);
  }

  async recordAccessEvent(input: Omit<AccessEventRecord, "id" | "revokedAt">): Promise<void> {
    return clients.recordAccessEvent(this.#clientHost(), input);
  }

  /* ---- grants (kernel-grants.ts) ---- */

  /** See `kernel-grants.ts` `requestGrant`: one open grant per (client, item), limiter counted once. */
  async requestGrant(input: grants.RequestGrantInput): Promise<grants.RequestGrantResult> {
    return grants.requestGrant(this.#grantHost(), input);
  }

  /** REST boundary check for `operator_email`: only this org's members may be addressed. */
  async assertMemberEmail(orgId: string, email: string): Promise<string> {
    return grants.assertMemberEmail(this.#grantHost(), orgId, email);
  }

  async approveGrant(input: grants.ApproveGrantInput): Promise<HostedGrantRecord> {
    return grants.approveGrant(this.#grantHost(), input);
  }

  /** A wrong code charges one attempt against the newest pending grant only (D14). */
  async approveByCode(orgId: string, actor: string, role: MemberRole, code: string): Promise<HostedGrantRecord> {
    return grants.approveByCode(this.#grantHost(), orgId, actor, role, code);
  }

  /** Revokes every open grant for the (client, item) pair and drops the policies that would re-grant it. */
  async revokeGrant(orgId: string, actor: string, grantId: string): Promise<HostedGrantRecord> {
    return grants.revokeGrant(this.#grantHost(), orgId, actor, grantId);
  }

  async inbox(orgId: string): Promise<HostedGrantRecord[]> {
    return this.store.listPendingGrants(orgId);
  }

  async inboxGrantCards(orgId: string): Promise<grants.InboxGrantCard[]> {
    return grants.inboxGrantCards(this.#grantHost(), orgId);
  }

  async listClientGrants(orgId: string, clientId: string): Promise<HostedGrantRecord[]> {
    return grants.listClientGrants(this.#grantHost(), orgId, clientId);
  }

  /** Validates a magic link and returns what approving it would do. No state change. */
  async previewMagic(orgId: string, token: string): Promise<grants.MagicPreview> {
    return grants.previewMagic(this.#grantHost(), orgId, token);
  }

  async approveMagic(orgId: string, actor: string, role: MemberRole, token: string): Promise<HostedGrantRecord> {
    return grants.approveMagic(this.#grantHost(), orgId, actor, role, token);
  }

  /** See `kernel-grants.ts` `consumeActiveGrant`: with `call`, the grant's scope must admit it. */
  async consumeActiveGrant(orgId: string, clientId: string, itemId: string, call?: grants.ConnectorCall): Promise<HostedGrantRecord> {
    return grants.consumeActiveGrant(this.#grantHost(), orgId, clientId, itemId, call);
  }

  async reactivatePromptGrant(grantId: string | undefined): Promise<boolean> {
    if (!grantId) return false;
    return this.store.reactivateGrant(grantId);
  }

  /* ---- provider user connect (kernel-connect.ts) ---- */

  async startProviderUserOauth(input: connect.StartConnectInput): Promise<connect.StartConnectResult> {
    return connect.startProviderUserOauth(this.#connectHost(), input);
  }

  async finishProviderUserOauth(input: connect.FinishConnectInput): Promise<connect.FinishConnectResult> {
    return connect.finishProviderUserOauth(this.#connectHost(), input);
  }

  /* ---- audit ---- */

  async writeAudit(orgId: string, action: string, actor: string, itemName: string | null, clientId: string | null): Promise<void> {
    await this.#audit(orgId, action, actor, itemName, clientId);
  }

  async #audit(orgId: string, action: string, actor: string, itemName: string | null, clientId: string | null): Promise<void> {
    await this.store.insertAudit({
      id: `aud_${randomUUID()}`,
      orgId,
      action,
      actor,
      itemName,
      clientId,
      at: this.now().toISOString(),
    });
  }

  /* ---- hosts for the sibling modules ---- */

  async #clientInOrg(orgId: string, clientId: string): Promise<ClientRecord> {
    const c = await this.store.getClient(clientId);
    if (!c || c.orgId !== orgId) throw new HttpError(404, "Unknown client");
    return c;
  }

  #orgHost(): orgs.OrgHost {
    const previous = this.#previousKek;
    return {
      store: this.store,
      now: this.now,
      wrapDek: (dek, orgId) => wrapDek(dek, this.#kek, orgId),
      unwrapDek: (envelope, orgId) => unwrapDek(envelope, this.#kek, orgId),
      ...(previous ? { unwrapDekPrevious: (envelope: Envelope, orgId: string) => unwrapDek(envelope, previous, orgId) } : {}),
    };
  }

  #itemHost(): items.ItemHost {
    return {
      store: this.store,
      now: this.now,
      deployPlane: this.deployPlane,
      assertPlane: (name) => this.#assertPlane(name),
      envFor: (orgId, name) => this.envFor(orgId, name),
      dekForOrg: (orgId) => this.dekForOrg(orgId),
      assertPlanLimit: (orgId, kind) => this.assertPlanLimit(orgId, kind),
      clientInOrg: (orgId, clientId) => this.#clientInOrg(orgId, clientId),
      consumeActiveGrant: (orgId, clientId, itemId, call) => this.consumeActiveGrant(orgId, clientId, itemId, call),
      needItemError: (input) => this.needItemError(input),
      audit: (orgId, action, actor, itemName, clientId) => this.#audit(orgId, action, actor, itemName, clientId),
    };
  }

  #clientHost(): clients.ClientHost {
    return {
      store: this.store,
      now: this.now,
      assertPlane: (name) => this.#assertPlane(name),
      assertPlanLimit: (orgId, kind) => this.assertPlanLimit(orgId, kind),
      clientInOrg: (orgId, clientId) => this.#clientInOrg(orgId, clientId),
      settleExpired: (rows) => grants.settleExpired(this.#grantHost(), rows),
      audit: (orgId, action, actor, itemName, clientId) => this.#audit(orgId, action, actor, itemName, clientId),
    };
  }

  #connectHost(): connect.ConnectHost {
    return {
      store: this.store,
      now: this.now,
      publicUrl: this.publicUrl,
      sealState: (payload) => sealOauthState(payload, this.#kek),
      openState: (state) => openOauthState(state, this.#kek, this.now().getTime()),
      envFor: (orgId, name) => this.envFor(orgId, name),
      clientInOrg: (orgId, clientId) => this.#clientInOrg(orgId, clientId),
      decryptItem: (orgId, itemId) => this.decryptItem(orgId, itemId),
      createItem: (input) => this.createItem(input),
      updateItem: (input) => this.updateItem(input),
      audit: (orgId, action, actor, itemName, clientId) => this.#audit(orgId, action, actor, itemName, clientId),
    };
  }

  #grantHost(): grants.GrantHost {
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

  #needHost(): needs.NeedHost {
    return {
      store: this.store,
      limiter: this.limiter,
      publicUrl: this.publicUrl,
      now: this.now,
      magicTtlMs: MAGIC_TTL_MS,
      maxItemBytes: items.MAX_ITEM_BYTES,
      envFor: (orgId, name) => this.envFor(orgId, name),
      dekForOrg: (orgId) => this.dekForOrg(orgId),
      clientInOrg: (orgId, clientId) => this.#clientInOrg(orgId, clientId),
      assertHosts: (hosts) => items.assertHosts(hosts),
      assertPlanLimit: (orgId, kind) => this.assertPlanLimit(orgId, kind),
      assertPlane: (name) => this.#assertPlane(name),
      standingFor: (orgId, clientId, item) => grants.standingFor(this.#grantHost(), orgId, clientId, item),
      publicItem: (environment, item) => items.publicItem(environment, item),
      audit: (orgId, action, actor, itemName, clientId) => this.#audit(orgId, action, actor, itemName, clientId),
    };
  }

  #memberHost(): members.MemberHost {
    return {
      store: this.store,
      now: this.now,
      publicUrl: this.publicUrl,
      planLimits: this.planLimits,
      inviteLimiter: this.inviteLimiter,
      sendEmail: this.sendEmail,
      audit: (orgId, action, actor, itemName, clientId) => this.#audit(orgId, action, actor, itemName, clientId),
    };
  }
}
