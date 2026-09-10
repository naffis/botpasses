/**
 * Grant and policy operations for the hosted kernel: request, approve (inbox, code, magic link),
 * revoke, consume, settle expiry, and the inbox and per-client views. Functions take a
 * `GrantHost` with the kernel's store, clock, notifier, and helpers, like `need-ops.ts`.
 * `HostedKernel` keeps its public method names and delegates here.
 *
 * Scope validation and enforcement live in `kernel-grant-scope.ts`; the code challenge, magic
 * link, and approval email in `kernel-grant-approval.ts`. Both are re-exported from here.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { nowIso } from "../ids.ts";
import { assertSafePublicObject } from "../redact.ts";
import {
  publicGrantScope,
  scopeFromPolicy,
  type ApprovalChallengeRecord,
  type ClientRecord,
  type EnvironmentRecord,
  type GrantPolicy,
  type GrantScopePublic,
  type HostedGrantRecord,
  type MemberRole,
  type PolicyRecord,
  type RequestedScope,
  type VaultEnvName,
} from "../hosted-types.ts";
import type { VaultStore } from "../store/types.ts";
import type { EmailDirectory } from "./email-directory.ts";
import { HttpError, InjectDeniedError, ScopeDeniedError, type NeedItemError } from "./errors.ts";
import {
  ensureMagicChallenge,
  hashCode,
  isPast,
  magicGrant,
  notify,
  notifyRecipients,
  rotateCodeChallenge,
} from "./kernel-grant-approval.ts";
import {
  itemHosts,
  requestFitsGrant,
  requestedScopeFor,
  resolveApprovalScope,
  scopeDenialReason,
  type ConnectorCall,
  type GrantRequest,
  type ScopeInput,
} from "./kernel-grant-scope.ts";
import { normalizeItemName } from "./kernel-items.ts";
import type { OrgRateLimiter } from "./rate-limit.ts";

export {
  CODE_TTL_MS,
  MAGIC_TTL_MS,
  assertMemberEmail,
  mintApprovalToken,
  previewMagic,
  verifyApprovalToken,
  type MagicPreview,
} from "./kernel-grant-approval.ts";
export {
  MAX_CALLS_CAP,
  SESSION_TTL_MAX_SECONDS,
  SESSION_TTL_MS,
  STANDING_TTL_MAX_SECONDS,
  TTL_MIN_SECONDS,
  pathWithinPrefix,
  requestFitsGrant,
  resolveApprovalScope,
  scopeDenialReason,
  type ConnectorCall,
  type GrantRequest,
  type ScopeDenial,
  type ScopeInput,
} from "./kernel-grant-scope.ts";

export type GrantHost = {
  store: VaultStore;
  now: () => Date;
  publicUrl: string;
  approvalHmac: Buffer | undefined;
  sendEmail: ((to: string, subject: string, html: string) => Promise<void>) | undefined;
  limiter: OrgRateLimiter;
  emails: EmailDirectory;
  envFor: (orgId: string, name: VaultEnvName) => Promise<EnvironmentRecord>;
  clientInOrg: (orgId: string, clientId: string) => Promise<ClientRecord>;
  needItemError: (input: {
    orgId: string;
    clientId: string;
    environment: VaultEnvName;
    itemName: string;
    host: string;
    taskDescription?: string;
    alreadyLimited?: boolean;
  }) => Promise<NeedItemError>;
  audit: (
    orgId: string,
    action: string,
    actor: string,
    itemName: string | null,
    clientId: string | null,
    host?: string | null,
  ) => Promise<void>;
};

export type InboxGrantCard = {
  id: string;
  status: string;
  policy: string;
  item_name: string | null;
  item_last4: string | null;
  client_name: string;
  task_description: string | null;
  created_at: string;
  approved_at: string | null;
  expires_at: string | null;
  requested_scope: RequestedScope | null;
  grant_scope: GrantScopePublic | null;
  allowed_hosts: string[];
};

/** Inbox and email copy: the agent's reason is cut to what a card can show (same cap as needs). */
const TASK_DESCRIPTION_MAX = 500;

function truncateTask(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  return t.length > TASK_DESCRIPTION_MAX ? t.slice(0, TASK_DESCRIPTION_MAX) : t;
}

export type RequestGrantInput = {
  orgId: string;
  clientId: string;
  itemName: string;
  environment: VaultEnvName;
  taskId?: string;
  taskDescription?: string;
  operatorEmail?: string;
  /** What the agent will call. Shown on the inbox card and used as the default approval scope. */
  request?: GrantRequest;
};

export type RequestGrantResult = { grant: HostedGrantRecord; code?: string; notifyFailed?: boolean };

/**
 * One covering grant per (client, item, requested call). An active grant or standing policy
 * satisfies the request only when host, method, and path fit its scope (or the agent stated
 * no call). Otherwise a pending grant is created, or the existing pending is reused with a
 * fresh approval code and the newest requested scope. The org limiter is counted here exactly
 * once per call, whichever surface (REST, request_grant, http_request) asked. Notification
 * goes to `operatorEmail` (must be a member) or to every member; it is sent for a new grant
 * or when the previous magic link expired, never on every retry.
 */
export async function requestGrant(host: GrantHost, raw: RequestGrantInput): Promise<RequestGrantResult> {
  const input: RequestGrantInput = { ...raw, taskDescription: truncateTask(raw.taskDescription) };
  if (!(await host.limiter.allow(input.orgId, host.now().getTime(), "grant"))) {
    throw new HttpError(429, "request_grant rate limit");
  }
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
      host: input.request?.host?.trim().toLowerCase() ?? "",
      taskDescription: input.taskDescription,
      alreadyLimited: true,
    });
  }
  const requested = requestedScopeFor(input.request, item);
  const recipients = await notifyRecipients(host, input.orgId, input.operatorEmail);
  const standing = await standingFor(host, input.orgId, client.id, item);
  const now = host.now();
  const at = nowIso(now);
  const pair = await settleExpired(host, await host.store.listGrantsForPair(input.orgId, client.id, item.id));
  const active = pair.find((g) => g.status === "active");
  const pending = pair.find((g) => g.status === "pending");
  const standingCovers = standing !== undefined && requestFitsGrant(standing, requested);
  const activeCovers = active !== undefined && requestFitsGrant(active, requested);
  let grant: HostedGrantRecord;
  let reusedPending = false;
  if (activeCovers && active) {
    grant = active;
  } else if (standingCovers && standing) {
    grant = pending
      ? { ...pending, ...scopeFromPolicy(standing), policy: standing.kind, status: "active", approvedAt: at }
      : newGrant(input, client.id, item, env.id, at, standing.kind, "active", requested, standing);
    if (pending) await host.store.updateGrant(grant);
    else await host.store.insertGrant(grant);
  } else if (pending) {
    grant = requested ? { ...pending, requestedScope: requested } : pending;
    if (requested) await host.store.updateGrant(grant);
    reusedPending = true;
  } else {
    grant = newGrant(input, client.id, item, env.id, at, "prompt", "pending", requested, undefined);
    await host.store.insertGrant(grant);
  }
  await host.audit(input.orgId, "request_grant", client.id, item.name, client.id);
  if (grant.status === "active") {
    assertSafePublicObject("requestGrant", grant);
    return { grant };
  }
  const code = await rotateCodeChallenge(host, grant.id, now);
  const magic = await ensureMagicChallenge(host, grant.orgId, grant.id, now);
  let notifyFailed = false;
  if (!reusedPending || magic.fresh) {
    notifyFailed = !(await notify(host, input.orgId, recipients, client, item, magic.token));
  }
  assertSafePublicObject("requestGrant", grant);
  return { grant, code, notifyFailed };
}

function newGrant(
  input: { orgId: string; taskId?: string; taskDescription?: string },
  clientId: string,
  item: { id: string; folderId: string | null },
  environmentId: string,
  at: string,
  policy: GrantPolicy,
  status: "active" | "pending",
  requested: RequestedScope | null,
  standing: PolicyRecord | undefined,
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
    createdAt: at,
    approvedAt: status === "active" ? at : null,
    consumedAt: null,
    taskId: input.taskId ?? null,
    taskDescription: input.taskDescription ?? null,
    requestedScope: requested,
    ...scopeFromPolicy(standing),
  };
}

/** D15: an active grant past `expires_at` reads as `expired`. */
export async function settleExpired(host: GrantHost, grants: HostedGrantRecord[]): Promise<HostedGrantRecord[]> {
  const now = host.now();
  const out: HostedGrantRecord[] = [];
  for (const g of grants) {
    if (g.status === "active" && isPast(g.expiresAt, now)) {
      const expired: HostedGrantRecord = { ...g, status: "expired" };
      await host.store.updateGrant(expired);
      out.push(expired);
    } else {
      out.push(g);
    }
  }
  return out;
}

export type ApproveGrantInput = {
  orgId: string;
  grantId: string;
  policy: GrantPolicy;
  confirmName?: string;
  role: MemberRole;
  actor: string;
  /** Operator limits. Omitted: the requested scope when the agent stated one, else unrestricted. */
  scope?: ScopeInput;
};

export async function approveGrant(host: GrantHost, input: ApproveGrantInput): Promise<HostedGrantRecord> {
  const grant = await host.store.getGrant(input.grantId);
  if (!grant || grant.orgId !== input.orgId) throw new HttpError(404, "Unknown grant");
  if (grant.status !== "pending") throw new HttpError(409, "Grant is not pending");
  if (input.policy === "folder_standing" && input.role !== "owner") {
    throw new HttpError(403, "Only owners may approve folder_standing");
  }
  const env = await host.store.getEnvironment(grant.environmentId);
  if (!env) throw new HttpError(404, "Unknown environment");
  if (input.policy === "folder_standing") {
    const folder = grant.folderId ? await host.store.getFolder(grant.folderId) : undefined;
    const expected = folder?.name ?? env.name;
    if (input.confirmName !== expected) {
      throw new HttpError(400, "confirm_name does not match folder or environment");
    }
  }
  const item = grant.itemId ? await host.store.getItem(grant.itemId) : undefined;
  if (!item) throw new HttpError(404, "Unknown item");
  const now = host.now();
  const at = nowIso(now);
  const client = await host.store.getClient(grant.clientId);
  const trusted = client?.kind === "trusted";
  const scope = resolveApprovalScope({
    scope: input.scope,
    // A trusted client's plain approve does not inherit the requested call: nothing could enforce
    // it on resolve, so the approval is unrestricted rather than refused (an explicit scope still is).
    requested: trusted ? null : grant.requestedScope,
    item,
    policy: input.policy,
    now,
  });
  if (trusted) refuseUnenforceableScope(scope);
  const next: HostedGrantRecord = {
    ...grant,
    ...scope,
    policy: input.policy,
    status: "active",
    approvedAt: at,
  };
  await host.store.updateGrant(next);
  if (input.policy === "item_standing" || input.policy === "folder_standing") {
    await dropStalePolicy(host, input.orgId, grant, input.policy);
    await host.store.insertPolicy({
      id: `pol_${randomUUID()}`,
      orgId: input.orgId,
      clientId: grant.clientId,
      itemId: input.policy === "item_standing" ? grant.itemId : null,
      folderId: input.policy === "folder_standing" ? grant.folderId : null,
      environmentId: grant.environmentId,
      kind: input.policy,
      createdAt: at,
      ...scope,
    });
  }
  await host.audit(input.orgId, "grant", input.actor, item.name, grant.clientId);
  assertSafePublicObject("approveGrant", next);
  return next;
}

/**
 * A trusted (`avt_`) client resolves the plaintext through `/runtime/resolve`, where there is no
 * call to check `methods`, `path_prefixes`, or `hosts` against. Writing those limits would show
 * the operator a restriction nothing enforces, so an approval that names them is refused;
 * `max_calls` and `ttl_seconds` are counted on resolve and stay allowed.
 */
function refuseUnenforceableScope(scope: { methods: string[] | null; pathPrefixes: string[] | null; hosts: string[] | null }): void {
  if (scope.methods === null && scope.pathPrefixes === null && scope.hosts === null) return;
  throw new HttpError(
    400,
    "Method, path, and host limits cannot be enforced for a trusted runtime client, which resolves the value directly. Approve with scope {} or with max_calls and ttl_seconds only.",
    { status: "scope_unenforceable", client_kind: "trusted" },
  );
}

/**
 * A standing policy row for this (client, item) or (client, folder, environment) may already
 * exist: expired or spent but never read since, or left by an approval that raced. The unique
 * indexes would reject the insert, so the stale row is removed first; the new approval's scope
 * and expiry replace it.
 */
async function dropStalePolicy(
  host: GrantHost,
  orgId: string,
  grant: HostedGrantRecord,
  policy: "item_standing" | "folder_standing",
): Promise<void> {
  const stale =
    policy === "item_standing"
      ? grant.itemId
        ? await host.store.findItemPolicy(orgId, grant.clientId, grant.itemId)
        : undefined
      : await host.store.findFolderPolicy(orgId, grant.clientId, grant.folderId, grant.environmentId);
  if (stale) await host.store.deletePolicy(stale.id);
}

const APPROVE_CODE_LIMIT_MESSAGE = "approve-by-code rate limit: 20 attempts per org per 15 minutes";

/**
 * Finds the pending challenge whose code matches. A wrong code charges one attempt against the
 * most recently requested pending grant only, so typos cannot lock out every open approval.
 * The org may try 20 codes per 15 minutes across every session (429 after that); attempts
 * carry over when the agent re-requests and the code rotates.
 */
export async function approveByCode(
  host: GrantHost,
  orgId: string,
  actor: string,
  role: MemberRole,
  code: string,
): Promise<HostedGrantRecord> {
  if (!(await host.limiter.allow(orgId, host.now().getTime(), "approve_code"))) {
    throw new HttpError(429, APPROVE_CODE_LIMIT_MESSAGE);
  }
  const pending = await host.store.listPendingGrants(orgId);
  const now = host.now();
  const candidates: { grant: HostedGrantRecord; ch: ApprovalChallengeRecord }[] = [];
  for (const grant of pending) {
    const ch = await host.store.getChallengeByGrantKind(grant.id, "code");
    if (ch && ch.kind === "code") candidates.push({ grant, ch });
  }
  let sawExpiredMatch = false;
  for (const { grant, ch } of candidates) {
    const [salt, expected] = ch.codeHash.split(":");
    if (!salt || !expected) continue;
    const actual = hashCode(code, salt);
    const ok = actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
    if (!ok) continue;
    if (isPast(ch.expiresAt, now)) {
      sawExpiredMatch = true;
      continue;
    }
    if (ch.attempts >= 5) continue;
    await host.store.deleteChallenge(ch.id);
    return approveGrant(host, { orgId, grantId: grant.id, policy: "prompt", role, actor });
  }
  if (sawExpiredMatch) throw new HttpError(410, "Expired code");
  const newest = candidates.find(({ ch }) => !isPast(ch.expiresAt, now) && ch.attempts < 5);
  if (newest) {
    await host.store.updateChallenge({ ...newest.ch, attempts: newest.ch.attempts + 1 });
  }
  throw new HttpError(409, "Invalid or reused code");
}

export async function approveMagic(
  host: GrantHost,
  orgId: string,
  actor: string,
  role: MemberRole,
  token: string,
): Promise<HostedGrantRecord> {
  const grant = await magicGrant(host, orgId, token);
  const magic = await host.store.getChallengeByGrantKind(grant.id, "magic");
  if (!magic) throw new HttpError(410, "Expired link");
  await host.store.deleteChallenge(magic.id);
  return approveGrant(host, { orgId, grantId: grant.id, policy: "prompt", role, actor });
}

/**
 * Drops the policies that would re-grant this grant's (client, item) pair: the item policy for
 * the pair always, and the (client, folder, environment) policy only when this grant was made
 * by it (`policy === "folder_standing"`). Revoking a prompt or item grant leaves a folder-wide
 * approval for other items in place; revoking a grant the folder policy activated ends that
 * approval for every item it covers, which is the blast radius the operator chose at approve.
 */
async function dropPoliciesFor(host: GrantHost, grant: HostedGrantRecord): Promise<void> {
  const policies = await host.store.listPoliciesForClient(grant.orgId, grant.clientId);
  for (const p of policies) {
    if (grant.itemId && p.itemId === grant.itemId) await host.store.deletePolicy(p.id);
    if (grant.policy === "folder_standing" && p.kind === "folder_standing" && p.environmentId === grant.environmentId) {
      if (p.folderId === grant.folderId) await host.store.deletePolicy(p.id);
    }
  }
}

/** Revokes every open grant for the (client, item) pair and drops the policies that would re-grant it. */
export async function revokeGrant(
  host: GrantHost,
  orgId: string,
  actor: string,
  grantId: string,
): Promise<HostedGrantRecord> {
  const grant = await host.store.getGrant(grantId);
  if (!grant || grant.orgId !== orgId) throw new HttpError(404, "Unknown grant");
  const next = { ...grant, status: "revoked" as const };
  await host.store.updateGrant(next);
  const pair = grant.itemId ? await host.store.listGrantsForPair(orgId, grant.clientId, grant.itemId) : [];
  const siblings = pair.filter((g) => g.id !== grant.id && (g.status === "active" || g.status === "pending"));
  for (const g of siblings) {
    await host.store.updateGrant({ ...g, status: "revoked" });
  }
  await dropPoliciesFor(host, grant);
  const item = grant.itemId ? await host.store.getItem(grant.itemId) : undefined;
  await host.audit(orgId, "revoke", actor, item?.name ?? null, grant.clientId);
  return next;
}

export async function inboxGrantCards(host: GrantHost, orgId: string): Promise<InboxGrantCard[]> {
  const all = await settleExpired(host, await host.store.listGrants(orgId));
  const rows = all.filter((g) => g.status === "pending" || (g.status === "active" && g.policy === "prompt"));
  const cards: InboxGrantCard[] = [];
  for (const g of rows) {
    const item = g.itemId ? await host.store.getItem(g.itemId) : undefined;
    const client = await host.store.getClient(g.clientId);
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
      expires_at: g.expiresAt,
      requested_scope: g.requestedScope,
      grant_scope: publicGrantScope(g),
      allowed_hosts: item ? itemHosts(item) : [],
    });
  }
  assertSafePublicObject("inboxGrantCards", cards);
  return cards;
}

export async function listClientGrants(host: GrantHost, orgId: string, clientId: string): Promise<HostedGrantRecord[]> {
  const all = await settleExpired(host, await host.store.listGrants(orgId));
  return all.filter((g) => g.clientId === clientId);
}

/**
 * Finds an active grant for the pair that admits `call` (when given) and spends it. With
 * `call`, a grant whose scope does not admit the call is skipped; if none admit it this is
 * 403 `scope_denied` (payload: `grant_scope`, `reason`; never the secret).
 * Prompt grants are consumed. Grants with `max_calls` count one call atomically and become
 * `consumed` on the last one, taking the standing policy that made them with them so the
 * approval does not renew itself. A standing (`item_standing` / `folder_standing`) consume
 * writes audit `auto_approved` with item name, client, and host (never values). Without
 * `call` (trusted `/runtime/resolve`), scope is not checked because there is no call to
 * check it against.
 */
export async function consumeActiveGrant(
  host: GrantHost,
  orgId: string,
  clientId: string,
  itemId: string,
  call?: ConnectorCall,
): Promise<HostedGrantRecord> {
  const pair = await settleExpired(host, await host.store.listGrantsForPair(orgId, clientId, itemId));
  const at = host.now();
  const actives = pair.filter((g) => g.status === "active");
  const first = actives[0];
  if (!first) throw new InjectDeniedError();
  let match = first;
  if (call) {
    const covering = actives.find((g) => scopeDenialReason(g, call) === undefined);
    if (!covering) {
      const item = await host.store.getItem(itemId);
      await host.audit(orgId, "scope_denied", clientId, item?.name ?? null, clientId);
      throw new ScopeDeniedError({
        reason: scopeDenialReason(first, call) ?? "path",
        grant_id: first.id,
        grant_scope: publicGrantScope(first),
      });
    }
    match = covering;
  }
  if (match.policy === "prompt") {
    const ok = await host.store.consumeGrant(match.id, nowIso(at));
    if (!ok) throw new InjectDeniedError();
    return { ...match, status: "consumed", consumedAt: nowIso(at) };
  }
  if (match.maxCalls === null) {
    await auditAutoApproved(host, orgId, clientId, itemId, match.policy, call?.host);
    return match;
  }
  const ok = await host.store.recordGrantCall(match.id, nowIso(at));
  if (!ok) throw new InjectDeniedError();
  const used = match.callsUsed + 1;
  const standing = await standingFor(host, orgId, clientId, {
    id: itemId,
    folderId: match.folderId,
    environmentId: match.environmentId,
  });
  if (standing) await host.store.recordPolicyCall(standing.id);
  await auditAutoApproved(host, orgId, clientId, itemId, match.policy, call?.host);
  if (used < match.maxCalls) return { ...match, callsUsed: used };
  await dropPoliciesFor(host, match);
  const item = await host.store.getItem(itemId);
  await host.audit(orgId, "grant_exhausted", clientId, item?.name ?? null, clientId);
  return { ...match, callsUsed: used, status: "consumed", consumedAt: nowIso(at) };
}

/** Standing consume: item name, client, and host. Never a secret value. */
async function auditAutoApproved(
  host: GrantHost,
  orgId: string,
  clientId: string,
  itemId: string,
  policy: GrantPolicy,
  hostName: string | undefined,
): Promise<void> {
  if (policy !== "item_standing" && policy !== "folder_standing") return;
  const item = await host.store.getItem(itemId);
  const hostNorm = hostName?.trim().toLowerCase() || null;
  await host.audit(orgId, "auto_approved", clientId, item?.name ?? null, clientId, hostNorm);
}

/** A standing policy that can still activate a grant: neither expired nor spent (`max_calls`). */
export function policyIsLive(policy: PolicyRecord, now: Date): boolean {
  const spent = policy.maxCalls !== null && policy.callsUsed >= policy.maxCalls;
  return !isPast(policy.expiresAt, now) && !spent;
}

/**
 * The standing policy that would activate a grant for this item, if one is still live. Expired
 * or spent policies are deleted on read so they never re-grant.
 */
export async function standingFor(
  host: GrantHost,
  orgId: string,
  clientId: string,
  item: { id: string; folderId: string | null; environmentId: string },
): Promise<PolicyRecord | undefined> {
  const now = host.now();
  const live = async (p: PolicyRecord | undefined): Promise<PolicyRecord | undefined> => {
    if (!p) return undefined;
    if (policyIsLive(p, now)) return p;
    await host.store.deletePolicy(p.id);
    return undefined;
  };
  const itemPol = await live(await host.store.findItemPolicy(orgId, clientId, item.id));
  if (itemPol) return itemPol;
  return live(await host.store.findFolderPolicy(orgId, clientId, item.folderId, item.environmentId));
}
