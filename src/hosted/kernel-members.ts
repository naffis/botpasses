/**
 * Team operations (task 3.7): members, roles, email invites, and the session org switcher.
 * Pure functions over a `MemberHost` so `HostedKernel` stays thin; the kernel supplies the
 * store, clock, plan limits, mailer, and audit writer.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { MemberRole } from "../hosted-types.ts";
import type { InviteRecord, VaultStore } from "../store/types.ts";
import { inviteEmail } from "./email.ts";
import { HttpError } from "./errors.ts";
import { normalizeEmail } from "./operator-identity.ts";
import { assertWithinLimit, type PlanLimits } from "./plan-limits.ts";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type MemberHost = {
  store: VaultStore;
  now: () => Date;
  publicUrl: string;
  planLimits: PlanLimits;
  sendEmail?: (to: string, subject: string, html: string) => Promise<void>;
  audit(orgId: string, action: string, actor: string, itemName: string | null, clientId: string | null): Promise<void>;
};

export type TeamMember = {
  user_id: string;
  email: string;
  role: MemberRole;
  joined_at: string | null;
};

export type PendingInvite = {
  id: string;
  email: string;
  role: MemberRole;
  created_at: string;
  expires_at: string;
  expired: boolean;
  invited_by_email: string | null;
};

export type TeamSnapshot = { members: TeamMember[]; invites: PendingInvite[] };

export type OrgSummary = { org_id: string; name: string; role: MemberRole; active: boolean };

export type InvitePreview = {
  org_id: string;
  org_name: string;
  email: string;
  role: MemberRole;
  expired: boolean;
  accepted: boolean;
};

export function asMemberRole(value: unknown): MemberRole {
  if (value === "owner" || value === "operator") return value;
  throw new HttpError(400, "role must be owner or operator");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function acceptInviteUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/$/, "")}/accept-invite?token=${encodeURIComponent(token)}`;
}

function requireOwner(role: MemberRole): void {
  if (role !== "owner") throw new HttpError(403, "Only owners may manage members");
}

function isExpired(invite: InviteRecord, now: Date): boolean {
  return Date.parse(invite.expiresAt) <= now.getTime();
}

function nowIso(host: MemberHost): string {
  return host.now().toISOString();
}

async function emailOf(store: VaultStore, userId: string): Promise<string | null> {
  const user = await store.getUser(userId);
  return user?.email ?? null;
}

/** Members plus unaccepted invites. Expired invites stay listed (flagged) until cancelled. */
export async function listTeam(host: MemberHost, orgId: string): Promise<TeamSnapshot> {
  const [rows, invites] = await Promise.all([host.store.listMembers(orgId), host.store.listInvites(orgId)]);
  const now = host.now();
  const members: TeamMember[] = [];
  for (const m of rows) {
    members.push({ user_id: m.userId, email: (await emailOf(host.store, m.userId)) ?? "", role: m.role, joined_at: m.joinedAt });
  }
  const pending: PendingInvite[] = [];
  for (const inv of invites) {
    pending.push({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      created_at: inv.createdAt,
      expires_at: inv.expiresAt,
      expired: isExpired(inv, now),
      invited_by_email: await emailOf(host.store, inv.invitedBy),
    });
  }
  return { members, invites: pending };
}

/** Seats in use for the plan limit: members plus invites that could still be accepted. */
export async function seatsInUse(host: MemberHost, orgId: string): Promise<number> {
  const [members, invites] = await Promise.all([host.store.listMembers(orgId), host.store.listInvites(orgId)]);
  const now = host.now();
  return members.length + invites.filter((i) => !isExpired(i, now)).length;
}

export async function inviteMember(
  host: MemberHost,
  input: { orgId: string; actorUserId: string; actorRole: MemberRole; email: string; role: MemberRole },
): Promise<{ invite: PendingInvite; accept_url: string; email_sent: boolean }> {
  requireOwner(input.actorRole);
  const email = normalizeEmail(input.email);
  const org = await host.store.getOrg(input.orgId);
  if (!org) throw new HttpError(404, "Unknown org");
  const existingUser = await host.store.getUserByEmail(email);
  if (existingUser && (await host.store.getMember(input.orgId, existingUser.id))) {
    throw new HttpError(409, "Already a member");
  }
  const now = host.now();
  const open = (await host.store.listInvites(input.orgId)).find((i) => i.email === email && !isExpired(i, now));
  if (open) throw new HttpError(409, "An invite for this email is already pending");
  assertWithinLimit("members", await seatsInUse(host, input.orgId), host.planLimits);
  const token = randomBytes(32).toString("base64url");
  const row: InviteRecord = {
    id: `inv_${randomUUID()}`,
    orgId: input.orgId,
    email,
    role: input.role,
    tokenHash: hashInviteToken(token),
    invitedBy: input.actorUserId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
    acceptedAt: null,
  };
  await host.store.insertInvite(row);
  await host.audit(input.orgId, "member_invited", input.actorUserId, null, null);
  const acceptUrl = acceptInviteUrl(host.publicUrl, token);
  let sent = false;
  if (host.sendEmail) {
    const inviter = (await emailOf(host.store, input.actorUserId)) ?? "A teammate";
    const mail = inviteEmail({ orgName: org.name, inviterEmail: inviter, role: input.role, acceptUrl });
    try {
      await host.sendEmail(email, mail.subject, mail.html);
      sent = true;
    } catch {
      sent = false;
    }
  }
  return {
    invite: {
      id: row.id,
      email: row.email,
      role: row.role,
      created_at: row.createdAt,
      expires_at: row.expiresAt,
      expired: false,
      invited_by_email: await emailOf(host.store, input.actorUserId),
    },
    accept_url: acceptUrl,
    email_sent: sent,
  };
}

export async function cancelInvite(
  host: MemberHost,
  input: { orgId: string; actorUserId: string; actorRole: MemberRole; inviteId: string },
): Promise<void> {
  requireOwner(input.actorRole);
  const invite = await host.store.getInvite(input.inviteId);
  if (!invite || invite.orgId !== input.orgId) throw new HttpError(404, "Unknown invite");
  await host.store.deleteInvite(invite.id);
}

async function ownerCount(store: VaultStore, orgId: string): Promise<number> {
  return (await store.listMembers(orgId)).filter((m) => m.role === "owner").length;
}

export async function updateMemberRole(
  host: MemberHost,
  input: { orgId: string; actorUserId: string; actorRole: MemberRole; userId: string; role: MemberRole },
): Promise<TeamMember> {
  requireOwner(input.actorRole);
  const member = await host.store.getMember(input.orgId, input.userId);
  if (!member) throw new HttpError(404, "Unknown member");
  if (member.role === "owner" && input.role !== "owner" && (await ownerCount(host.store, input.orgId)) <= 1) {
    throw new HttpError(400, "An org needs at least one owner");
  }
  if (member.role !== input.role) {
    await host.store.updateMemberRole(input.orgId, input.userId, input.role);
    await host.audit(input.orgId, "member_role", input.actorUserId, null, null);
  }
  const rows = await host.store.listMembers(input.orgId);
  const row = rows.find((m) => m.userId === input.userId);
  return {
    user_id: input.userId,
    email: (await emailOf(host.store, input.userId)) ?? "",
    role: input.role,
    joined_at: row?.joinedAt ?? null,
  };
}

/** The last owner cannot leave or be removed; that includes the caller removing themself. */
export async function removeMember(
  host: MemberHost,
  input: { orgId: string; actorUserId: string; actorRole: MemberRole; userId: string },
): Promise<void> {
  requireOwner(input.actorRole);
  const member = await host.store.getMember(input.orgId, input.userId);
  if (!member) throw new HttpError(404, "Unknown member");
  if (member.role === "owner" && (await ownerCount(host.store, input.orgId)) <= 1) {
    throw new HttpError(400, "Cannot remove the last owner");
  }
  await host.store.removeMember(input.orgId, input.userId);
  await host.audit(input.orgId, "member_removed", input.actorUserId, null, null);
}

async function inviteForToken(host: MemberHost, token: string): Promise<InviteRecord> {
  if (!token || token.length > 512) throw new HttpError(404, "Invalid invite");
  const invite = await host.store.getInviteByTokenHash(hashInviteToken(token));
  if (!invite) throw new HttpError(404, "Invalid invite");
  return invite;
}

/** What the accept page shows before the visitor commits. No state change. */
export async function previewInvite(host: MemberHost, token: string): Promise<InvitePreview> {
  const invite = await inviteForToken(host, token);
  const org = await host.store.getOrg(invite.orgId);
  if (!org) throw new HttpError(404, "Invalid invite");
  return {
    org_id: invite.orgId,
    org_name: org.name,
    email: invite.email,
    role: invite.role,
    expired: isExpired(invite, host.now()),
    accepted: invite.acceptedAt !== null,
  };
}

/**
 * Joins the signed-in user to the invite's org. The signed-in email must match the invited
 * address; a member who follows a stale link is told so instead of being re-added.
 */
export async function acceptInvite(
  host: MemberHost,
  input: { userId: string; email: string; token: string },
): Promise<{ org_id: string; org_name: string; role: MemberRole }> {
  const invite = await inviteForToken(host, input.token);
  const org = await host.store.getOrg(invite.orgId);
  if (!org) throw new HttpError(404, "Invalid invite");
  if (invite.acceptedAt !== null) throw new HttpError(410, "This invite was already used");
  if (isExpired(invite, host.now())) throw new HttpError(410, "This invite has expired");
  if (invite.email !== input.email.trim().toLowerCase()) {
    throw new HttpError(403, "invite_email_mismatch");
  }
  const at = nowIso(host);
  const existing = await host.store.getMember(invite.orgId, input.userId);
  if (existing) {
    await host.store.acceptInvite(invite.id, at);
    return { org_id: org.id, org_name: org.name, role: existing.role };
  }
  const members = await host.store.listMembers(invite.orgId);
  assertWithinLimit("members", members.length, host.planLimits);
  await host.store.insertMember({ orgId: invite.orgId, userId: input.userId, role: invite.role, joinedAt: at });
  await host.store.acceptInvite(invite.id, at);
  await host.audit(invite.orgId, "member_joined", input.userId, null, null);
  return { org_id: org.id, org_name: org.name, role: invite.role };
}

/** Orgs the user belongs to, with the one this session resolves to marked active. */
export async function listOrgsForUser(host: MemberHost, userId: string, activeOrgId: string): Promise<OrgSummary[]> {
  const memberships = await host.store.listMembershipsForUser(userId);
  const out: OrgSummary[] = [];
  for (const m of memberships) {
    const org = await host.store.getOrg(m.orgId);
    if (!org) continue;
    out.push({ org_id: m.orgId, name: org.name, role: m.role, active: m.orgId === activeOrgId });
  }
  return out;
}

/** Records the switcher choice on the session. Membership is checked so a stale id cannot be pinned. */
export async function setActiveOrg(
  host: MemberHost,
  input: { userId: string; sessionHash: string; orgId: string },
): Promise<OrgSummary> {
  const member = await host.store.getMember(input.orgId, input.userId);
  if (!member) throw new HttpError(403, "Not a member of this org");
  const org = await host.store.getOrg(input.orgId);
  if (!org) throw new HttpError(404, "Unknown org");
  await host.store.setSessionActiveOrg(input.sessionHash, input.orgId);
  return { org_id: org.id, name: org.name, role: member.role, active: true };
}
