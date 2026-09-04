/**
 * Grant and policy operations for the hosted kernel: request, approve (inbox, code, magic link),
 * revoke, consume, settle expiry, and the inbox and per-client views. Functions take a
 * `GrantHost` with the kernel's store, clock, notifier, and helpers, like `need-ops.ts`.
 * `HostedKernel` keeps its public method names and delegates here.
 */
import { createHmac, createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { normalizeSecretName } from "../ids.ts";
import { assertSafePublicObject } from "../redact.ts";
import type {
  ApprovalChallengeRecord,
  ClientRecord,
  EnvironmentRecord,
  GrantPolicy,
  HostedGrantRecord,
  MemberRole,
  PolicyRecord,
  VaultEnvName,
} from "../hosted-types.ts";
import type { VaultStore } from "../store/types.ts";
import { escapeHtml } from "./auth-shell.ts";
import { HttpError, type NeedItemError } from "./errors.ts";
import type { OrgRateLimiter } from "./rate-limit.ts";

export const SESSION_TTL_MS = 8 * 3600 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAGIC_TTL_MS = 15 * 60 * 1000;

export type GrantHost = {
  store: VaultStore;
  now: () => Date;
  publicUrl: string;
  approvalHmac: Buffer | undefined;
  sendEmail: ((to: string, subject: string, html: string) => Promise<void>) | undefined;
  limiter: OrgRateLimiter;
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
};

function nowIso(d: Date): string {
  return d.toISOString();
}

function hashCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
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

export type RequestGrantInput = {
  orgId: string;
  clientId: string;
  itemName: string;
  environment: VaultEnvName;
  taskId?: string;
  taskDescription?: string;
  operatorEmail?: string;
};

export type RequestGrantResult = { grant: HostedGrantRecord; code?: string; notifyFailed?: boolean };

/**
 * One open grant per (client, item). A standing policy activates immediately; otherwise the
 * existing pending grant is reused with a fresh approval code. The org limiter is counted here
 * exactly once per call, whichever surface (REST, request_grant, http_request) asked.
 * Notification goes to `operatorEmail` (must be a member) or to every member; it is sent for a
 * new grant or when the previous magic link expired, never on every retry.
 */
export async function requestGrant(host: GrantHost, input: RequestGrantInput): Promise<RequestGrantResult> {
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
      host: "",
      taskDescription: input.taskDescription,
      alreadyLimited: true,
    });
  }
  const recipients = await notifyRecipients(host, input.orgId, input.operatorEmail);
  const standing = await standingFor(host, input.orgId, client.id, item);
  const now = host.now();
  const at = nowIso(now);
  const open = await openGrantFor(host, input.orgId, client.id, item.id);
  let grant: HostedGrantRecord;
  if (open && open.status === "active") {
    grant = open;
  } else if (standing) {
    grant = open
      ? { ...open, policy: standing.kind, status: "active", approvedAt: at, expiresAt: null }
      : newGrant(input, client.id, item, env.id, at, standing.kind, "active");
    if (open) await host.store.updateGrant(grant);
    else await host.store.insertGrant(grant);
  } else if (open) {
    grant = open;
  } else {
    grant = newGrant(input, client.id, item, env.id, at, "prompt", "pending");
    await host.store.insertGrant(grant);
  }
  await host.audit(input.orgId, "request_grant", client.id, item.name, client.id);
  if (grant.status === "active") {
    assertSafePublicObject("requestGrant", grant);
    return { grant };
  }
  const code = await rotateCodeChallenge(host, grant.id, now);
  const magic = await ensureMagicChallenge(host, grant.id, now);
  let notifyFailed = false;
  if (!open || magic.fresh) {
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
async function openGrantFor(
  host: GrantHost,
  orgId: string,
  clientId: string,
  itemId: string,
): Promise<HostedGrantRecord | undefined> {
  const grants = await settleExpired(host, await host.store.listGrants(orgId));
  const pair = grants.filter((g) => g.clientId === clientId && g.itemId === itemId);
  return pair.find((g) => g.status === "active") ?? pair.find((g) => g.status === "pending");
}

/** D15: an active `session` grant past `expires_at` reads as `expired`. */
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

async function rotateCodeChallenge(host: GrantHost, grantId: string, now: Date): Promise<string> {
  const prior = await host.store.getChallengeByGrantKind(grantId, "code");
  if (prior) await host.store.deleteChallenge(prior.id);
  const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
  const salt = randomBytes(8).toString("hex");
  await host.store.insertChallenge({
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
async function ensureMagicChallenge(
  host: GrantHost,
  grantId: string,
  now: Date,
): Promise<{ token?: string; fresh: boolean }> {
  if (!host.approvalHmac) return { fresh: true };
  const prior = await host.store.getChallengeByGrantKind(grantId, "magic");
  if (prior && !isPast(prior.expiresAt, now)) return { token: prior.codeHash, fresh: false };
  if (prior) await host.store.deleteChallenge(prior.id);
  const exp = now.getTime() + MAGIC_TTL_MS;
  const token = mintApprovalToken(host.approvalHmac, grantId, exp);
  await host.store.insertChallenge({
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
async function notifyRecipients(host: GrantHost, orgId: string, operatorEmail: string | undefined): Promise<string[]> {
  if (operatorEmail !== undefined) return [operatorEmail.trim().toLowerCase()];
  return host.store.listMemberEmails(orgId);
}

/** REST boundary check for `operator_email`: only this org's members may be addressed. */
export async function assertMemberEmail(host: GrantHost, orgId: string, email: string): Promise<string> {
  const wanted = email.trim().toLowerCase();
  const members = await host.store.listMemberEmails(orgId);
  if (!members.some((m) => m.toLowerCase() === wanted)) {
    throw new HttpError(400, "operator_email must be a member of this org");
  }
  return wanted;
}

/** Sends the approval email to each recipient. True when at least one send succeeded. */
async function notify(
  host: GrantHost,
  orgId: string,
  recipients: string[],
  client: ClientRecord,
  item: { name: string; last4: string },
  magicToken: string | undefined,
): Promise<boolean> {
  let sent = 0;
  if (host.sendEmail && recipients.length > 0) {
    const link = magicToken
      ? `${host.publicUrl}/approve?token=${encodeURIComponent(magicToken)}`
      : `${host.publicUrl.replace(/\/$/, "")}/console`;
    const html =
      `<p>Client ${escapeHtml(client.name)} requested ${escapeHtml(item.name)} (••••${escapeHtml(item.last4)}).</p>` +
      `<p>Approve in inbox or use the code in the agent result.</p>` +
      `<p><a href="${escapeHtml(link)}">Approve</a></p>`;
    for (const to of recipients) {
      try {
        await host.sendEmail(to, `Grant request ${item.name}`, html);
        sent += 1;
      } catch {
        // counted below
      }
    }
  }
  if (sent === 0) {
    await host.audit(orgId, "notify_failed", "system", item.name, client.id);
    return false;
  }
  return true;
}

export type ApproveGrantInput = {
  orgId: string;
  grantId: string;
  policy: GrantPolicy;
  confirmName?: string;
  role: MemberRole;
  actor: string;
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
  const at = nowIso(host.now());
  const expiresAt =
    input.policy === "session" ? new Date(host.now().getTime() + SESSION_TTL_MS).toISOString() : null;
  const next: HostedGrantRecord = {
    ...grant,
    policy: input.policy,
    status: "active",
    approvedAt: at,
    expiresAt,
  };
  await host.store.updateGrant(next);
  if (input.policy === "item_standing" && grant.itemId) {
    await host.store.insertPolicy({
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
    await host.store.insertPolicy({
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
  const item = grant.itemId ? await host.store.getItem(grant.itemId) : undefined;
  await host.audit(input.orgId, "grant", input.actor, item?.name ?? null, grant.clientId);
  assertSafePublicObject("approveGrant", next);
  return next;
}

/**
 * Finds the pending challenge whose code matches. A wrong code charges one attempt against the
 * most recently requested pending grant only, so typos cannot lock out every open approval.
 */
export async function approveByCode(
  host: GrantHost,
  orgId: string,
  actor: string,
  role: MemberRole,
  code: string,
): Promise<HostedGrantRecord> {
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
  const siblings = (await host.store.listGrants(orgId)).filter(
    (g) =>
      g.id !== grant.id &&
      g.clientId === grant.clientId &&
      g.itemId === grant.itemId &&
      (g.status === "active" || g.status === "pending"),
  );
  for (const g of siblings) {
    await host.store.updateGrant({ ...g, status: "revoked" });
  }
  const policies = await host.store.listPoliciesForClient(orgId, grant.clientId);
  for (const p of policies) {
    if (grant.itemId && p.itemId === grant.itemId) await host.store.deletePolicy(p.id);
    if (p.kind === "folder_standing" && p.environmentId === grant.environmentId) {
      if (p.folderId === grant.folderId) await host.store.deletePolicy(p.id);
    }
  }
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
    });
  }
  return cards;
}

export async function listClientGrants(host: GrantHost, orgId: string, clientId: string): Promise<HostedGrantRecord[]> {
  const all = await settleExpired(host, await host.store.listGrants(orgId));
  return all.filter((g) => g.clientId === clientId);
}

export type MagicPreview = {
  grant_id: string;
  client_name: string;
  item_name: string;
  item_last4: string;
  policy: string;
  task_description: string | null;
};

/** Validates a magic link and returns what approving it would do. No state change. */
export async function previewMagic(host: GrantHost, orgId: string, token: string): Promise<MagicPreview> {
  const grant = await magicGrant(host, orgId, token);
  const item = grant.itemId ? await host.store.getItem(grant.itemId) : undefined;
  const client = await host.store.getClient(grant.clientId);
  const preview: MagicPreview = {
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

async function magicGrant(host: GrantHost, orgId: string, token: string): Promise<HostedGrantRecord> {
  if (!host.approvalHmac) throw new HttpError(500, "Magic links are not configured");
  const grantId = verifyApprovalToken(host.approvalHmac, token, host.now().getTime());
  const grant = await host.store.getGrant(grantId);
  if (!grant || grant.orgId !== orgId) throw new HttpError(404, "Unknown grant");
  if (grant.status !== "pending") throw new HttpError(410, "Expired link");
  const magic = await host.store.getChallengeByGrantKind(grantId, "magic");
  if (!magic || magic.codeHash !== token) throw new HttpError(410, "Expired link");
  return grant;
}

export async function consumeActiveGrant(
  host: GrantHost,
  orgId: string,
  clientId: string,
  itemId: string,
): Promise<HostedGrantRecord> {
  const grants = await settleExpired(host, await host.store.listGrants(orgId));
  const at = host.now();
  const match = grants.find((g) => g.clientId === clientId && g.itemId === itemId && g.status === "active");
  if (!match) throw new HttpError(403, "inject_denied");
  if (match.policy === "prompt") {
    const ok = await host.store.consumeGrant(match.id, nowIso(at));
    if (!ok) throw new HttpError(403, "inject_denied");
    return { ...match, status: "consumed", consumedAt: nowIso(at) };
  }
  return match;
}

export async function standingFor(
  host: GrantHost,
  orgId: string,
  clientId: string,
  item: { id: string; folderId: string | null; environmentId: string },
): Promise<PolicyRecord | undefined> {
  const itemPol = await host.store.findItemPolicy(orgId, clientId, item.id);
  if (itemPol) return itemPol;
  return host.store.findFolderPolicy(orgId, clientId, item.folderId, item.environmentId);
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
