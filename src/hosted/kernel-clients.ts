/**
 * Client (agent) operations for the hosted kernel: issue and rotate machine tokens, create or
 * reuse OAuth model clients, move a client between environments, revoke clients and operator
 * sessions, and the Access snapshot. Functions take a `ClientHost` with the kernel's store,
 * clock, and helpers, like `kernel-grants.ts`. `HostedKernel` delegates here.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { last4 } from "../ids.ts";
import { assertSafePublicObject } from "../redact.ts";
import {
  emptyClientFields,
  publicGrantScope,
  type AccessEventRecord,
  type ClientRecord,
  type HostedGrantRecord,
  type MemberRole,
  type VaultEnvName,
} from "../hosted-types.ts";
import type { VaultStore } from "../store/types.ts";
import { clientUsage, grantUsage, sessionUsage } from "./access-usage.ts";
import { HttpError } from "./errors.ts";
import { logAuthEvent } from "./observe.ts";
import { destroyOidcPayloadsForClient } from "./oidc-adapter.ts";
import type { PlanLimitKind } from "./plan-limits.ts";

/** Access shows `idHash.slice(0, 12)`; anything shorter is not a session id. */
const SESSION_ID_MIN_CHARS = 12;

export type ClientHost = {
  store: VaultStore;
  now: () => Date;
  assertPlane: (name: VaultEnvName) => void;
  assertPlanLimit: (orgId: string, kind: PlanLimitKind) => Promise<void>;
  clientInOrg: (orgId: string, clientId: string) => Promise<ClientRecord>;
  settleExpired: (grants: HostedGrantRecord[]) => Promise<HostedGrantRecord[]>;
  audit: (
    orgId: string,
    action: string,
    actor: string,
    itemName: string | null,
    clientId: string | null,
  ) => Promise<void>;
};

export type CreateTrustedClientInput = { orgId: string; name: string; environment: VaultEnvName };

export type CreateModelClientInput = {
  orgId: string;
  name: string;
  environment: VaultEnvName;
  clerkOauthUserId?: string;
  issueBearer?: boolean;
};

export type EnsureModelClientInput = {
  orgId: string;
  name: string;
  environment: VaultEnvName;
  clerkOauthUserId: string;
};

export type SessionActor = { userId: string; role: MemberRole; sessionHash: string };

function nowIso(d: Date): string {
  return d.toISOString();
}

export function hashSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function recordAccessEvent(host: ClientHost, input: Omit<AccessEventRecord, "id" | "revokedAt">): Promise<void> {
  await host.store.insertAccessEvent({
    id: `aev_${randomUUID()}`,
    ...input,
    revokedAt: null,
  });
}

async function recordMachineIssue(host: ClientHost, row: ClientRecord, plaintext: string): Promise<void> {
  const at = nowIso(host.now());
  await host.store.setClientLastTokenAt(row.id, at);
  await recordAccessEvent(host, {
    orgId: row.orgId,
    clientId: row.id,
    actorUserId: null,
    kind: "machine",
    jtiHash: hashSecret(plaintext),
    issuedAt: at,
    expiresAt: null,
  });
  await host.audit(row.orgId, "token_issued", row.id, null, row.id);
}

export async function rotateClient(
  host: ClientHost,
  orgId: string,
  actor: string,
  clientId: string,
): Promise<{ token: string; client_id: string }> {
  const client = await host.clientInOrg(orgId, clientId);
  const prefix = client.kind === "trusted" ? "avt_" : "avm_";
  const plaintext = `${prefix}${randomBytes(24).toString("hex")}`;
  await host.store.updateClientHashedSecret(client.id, hashSecret(plaintext), last4(plaintext));
  await host.audit(orgId, "client_rotate", actor, null, client.id);
  return { token: plaintext, client_id: client.id };
}

export async function createTrustedClient(
  host: ClientHost,
  input: CreateTrustedClientInput,
): Promise<{ client: ClientRecord; plaintext: string }> {
  host.assertPlane(input.environment);
  await host.assertPlanLimit(input.orgId, "agents");
  const plaintext = `avt_${randomBytes(24).toString("hex")}`;
  const row: ClientRecord = {
    id: `cli_${randomUUID()}`,
    orgId: input.orgId,
    kind: "trusted",
    name: input.name,
    hashedSecret: hashSecret(plaintext),
    clerkOauthUserId: null,
    environment: input.environment,
    ...emptyClientFields(),
    last4: last4(plaintext),
  };
  await host.store.insertClient(row);
  await recordMachineIssue(host, row, plaintext);
  return { client: row, plaintext };
}

export async function createModelClient(
  host: ClientHost,
  input: CreateModelClientInput,
): Promise<{ client: ClientRecord; plaintext?: string }> {
  host.assertPlane(input.environment);
  await host.assertPlanLimit(input.orgId, "agents");
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
  await host.store.insertClient(row);
  if (plaintext) await recordMachineIssue(host, row, plaintext);
  return { client: row, plaintext };
}

/** Reuses the live model client for this OAuth id. Revoked clients are never resurrected. */
export async function ensureModelClient(host: ClientHost, input: EnsureModelClientInput): Promise<ClientRecord> {
  const clients = await host.store.listClients(input.orgId);
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
    await host.store.setClientRevoked(revoked.id, null);
    await host.audit(input.orgId, "client_reactivated", "oauth", null, revoked.id);
    const fresh = await host.store.getClient(revoked.id);
    if (fresh) return fresh;
  }
  const created = await createModelClient(host, input);
  return created.client;
}

/** Operator-only. Moves a client (including OAuth-issued ones) to another vault environment. */
export async function setClientEnvironment(
  host: ClientHost,
  orgId: string,
  actor: string,
  clientId: string,
  environment: VaultEnvName,
): Promise<ClientRecord> {
  host.assertPlane(environment);
  const client = await host.clientInOrg(orgId, clientId);
  if (client.revokedAt) throw new HttpError(409, "Client is revoked");
  if (client.environment !== environment) {
    await host.store.updateClientEnvironment(client.id, environment);
    await host.audit(orgId, "client_environment", actor, null, client.id);
  }
  return { ...client, environment };
}

export async function lookupTrustedToken(host: ClientHost, token: string): Promise<ClientRecord | undefined> {
  return host.store.findClientByHashedSecret(hashSecret(token));
}

export async function revokeClient(host: ClientHost, orgId: string, actor: string, clientId: string): Promise<void> {
  const client = await host.store.getClient(clientId);
  if (!client || client.orgId !== orgId) throw new HttpError(404, "Unknown client");
  const at = nowIso(host.now());
  await host.store.setClientRevoked(clientId, at);
  await host.store.revokeAccessEventsForClient(clientId, at);
  const grants = await host.store.listGrants(orgId);
  for (const g of grants) {
    if (g.clientId === clientId && (g.status === "active" || g.status === "pending")) {
      await host.store.updateGrant({ ...g, status: "revoked" });
    }
  }
  await destroyOidcPayloadsForClient(host.store, client);
  await host.audit(orgId, "client_revoked", actor, null, clientId);
}

/**
 * `sessionId` is the 12+ character hash prefix shown in Access (or the full hash). Members may
 * revoke their own sessions; only owners may revoke another member's.
 */
export async function revokeSession(host: ClientHost, orgId: string, actor: SessionActor, sessionId: string): Promise<void> {
  if (sessionId.length < SESSION_ID_MIN_CHARS || !/^[0-9a-f]+$/i.test(sessionId)) {
    throw new HttpError(400, "Session id must be at least 12 hex characters");
  }
  const sessions = await host.store.listOperatorSessions(orgId);
  const matches = sessions.filter((s) => s.idHash.startsWith(sessionId.toLowerCase()));
  const match = matches[0];
  if (!match || matches.length > 1) throw new HttpError(404, "Unknown session");
  if (match.idHash === actor.sessionHash) throw new HttpError(400, "cannot_revoke_current");
  logAuthEvent("session_revoked", {
    org_id: orgId,
    actor_user_id: actor.userId,
    user_id: match.userId,
    session_id: match.idHash.slice(0, SESSION_ID_MIN_CHARS),
  });
  if (match.userId !== actor.userId && actor.role !== "owner") {
    throw new HttpError(403, "Only owners may revoke another member's session");
  }
  await host.store.deleteSession(match.idHash);
}

export async function listAccess(host: ClientHost, orgId: string, currentSessionHash?: string) {
  const [members, clients, storedGrants, sessions, audit, events] = await Promise.all([
    host.store.listMembers(orgId),
    host.store.listClients(orgId),
    host.store.listGrants(orgId),
    host.store.listOperatorSessions(orgId),
    host.store.listAudit(orgId, 200, { action: "inject" }),
    host.store.listAccessEvents(orgId, 200),
  ]);
  const grants = await host.settleExpired(storedGrants);
  const users = await Promise.all(members.map((m) => host.store.getUser(m.userId)));
  const operators = members.map((m, i) => ({
    user_id: m.userId,
    role: m.role,
    email: users[i]?.email ?? "",
  }));
  const clientRows = await Promise.all(
    clients.map(async (c) => {
      const actor = c.consentedByUserId ? await host.store.getUser(c.consentedByUserId) : undefined;
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
        const item = await host.store.getItem(g.itemId);
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
