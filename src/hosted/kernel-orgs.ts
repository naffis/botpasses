/**
 * Org lifecycle for the hosted kernel: provisioning (org, owner, vault, environments, wrapped
 * DEK), the bootstrap operator, the org an operator session acts in, delete, and KEK rotation.
 * The KEK stays inside `HostedKernel`; the host exposes `wrapDek`/`unwrapDek` closures over it.
 */
import { randomUUID } from "node:crypto";
import type { Envelope } from "../crypto.ts";
import type { MemberRole } from "../hosted-types.ts";
import { isUniqueViolation, StoreConflictError } from "../store/conflict.ts";
import type { VaultStore } from "../store/types.ts";
import { HttpError } from "./errors.ts";
import { IdentityKeyring, type IdentityRotateResult } from "./identity-keys.ts";
import { generateDek, unwrapDek, wrapDek } from "./kek.ts";
import { logVaultEvent } from "./observe.ts";

/** Single-operator org when `VAULT_BOOTSTRAP_TOKEN` is set. */
export const BOOTSTRAP_ORG_ID = "org_bootstrap";
export const BOOTSTRAP_USER_ID = "user_bootstrap";

export type OrgHost = {
  store: VaultStore;
  now: () => Date;
  wrapDek: (dek: Buffer, orgId: string) => Envelope;
  unwrapDek: (envelope: Envelope, orgId: string) => Buffer;
};

export type Membership = { orgId: string; role: MemberRole };

export async function requireMember(host: OrgHost, orgId: string, userId: string): Promise<MemberRole> {
  const m = await host.store.getMember(orgId, userId);
  if (!m) throw new HttpError(403, "Not a member of this org");
  return m.role;
}

export async function provisionOrg(host: OrgHost, orgId: string, name: string, userId: string): Promise<void> {
  const wrapped = host.wrapDek(generateDek(), orgId);
  const at = host.now().toISOString();
  await host.store.insertOrg({
    id: orgId,
    name,
    wrappedDekIv: wrapped.iv,
    wrappedDekCiphertext: wrapped.ciphertext,
    wrappedDekTag: wrapped.tag,
    createdAt: at,
  });
  await host.store.insertMember({ orgId, userId, role: "owner", joinedAt: at });
  const vaultId = `vlt_${randomUUID()}`;
  await host.store.insertVault({ id: vaultId, orgId, name: "default" });
  for (const environment of ["staging", "production"] as const) {
    await host.store.insertEnvironment({ id: `env_${randomUUID()}`, vaultId, name: environment });
  }
}

export async function createOrg(host: OrgHost, name: string, userId: string): Promise<{ orgId: string }> {
  const orgId = `org_${randomUUID()}`;
  await provisionOrg(host, orgId, name, userId);
  return { orgId };
}

export async function ensureBootstrapOperator(host: OrgHost): Promise<{ orgId: string; userId: string; role: MemberRole }> {
  const orgId = BOOTSTRAP_ORG_ID;
  const userId = BOOTSTRAP_USER_ID;
  const existing = await host.store.getOrg(orgId);
  if (!existing) {
    await provisionOrg(host, orgId, "personal", userId);
  } else if (!(await host.store.getMember(orgId, userId))) {
    await host.store.insertMember({ orgId, userId, role: "owner" });
  }
  const role = await requireMember(host, orgId, userId);
  return { orgId, userId, role };
}

/**
 * The org an operator session acts in. `preferredOrgId` (the session's `active_org_id` from the
 * switcher) wins when the user is still a member of it; otherwise the first membership, and a
 * fresh personal org for a user with none.
 */
export async function ensureVaultOrgForUser(host: OrgHost, userId: string, preferredOrgId?: string | null): Promise<Membership> {
  const existing = await host.store.listMembershipsForUser(userId);
  if (preferredOrgId) {
    const preferred = existing.find((m) => m.orgId === preferredOrgId);
    if (preferred) return { orgId: preferred.orgId, role: preferred.role };
  }
  if (existing[0]) return { orgId: existing[0].orgId, role: existing[0].role };
  const orgId = `org_${userId.replace(/^usr_/, "")}`;
  try {
    await provisionOrg(host, orgId, "workspace", userId);
  } catch (err) {
    if (!(err instanceof StoreConflictError) && !isUniqueViolation(err)) {
      const again = await host.store.listMembershipsForUser(userId);
      if (again[0]) return { orgId: again[0].orgId, role: again[0].role };
      throw err;
    }
    if (!(await host.store.getMember(orgId, userId))) {
      await host.store.insertMember({ orgId, userId, role: "owner" });
    }
  }
  const again = await host.store.listMembershipsForUser(userId);
  if (again[0]) return { orgId: again[0].orgId, role: again[0].role };
  const role = await requireMember(host, orgId, userId);
  return { orgId, role };
}

export async function deleteOrg(host: OrgHost, orgId: string, actor: string, role: MemberRole, confirmName: string): Promise<void> {
  if (role !== "owner") throw new HttpError(403, "Only owners may delete the org");
  const org = await host.store.getOrg(orgId);
  if (!org) throw new HttpError(404, "Unknown org");
  const prod = await host.store.countProductionItems(orgId);
  if (prod > 0 && confirmName !== org.name) {
    throw new HttpError(400, "confirm_name must match the org name when production items exist");
  }
  logVaultEvent("delete_org", { orgId, actor });
  await host.store.deleteOrg(orgId);
}

export async function dekForOrg(host: OrgHost, orgId: string): Promise<Buffer> {
  const org = await host.store.getOrg(orgId);
  if (!org) throw new HttpError(404, "Unknown org");
  return host.unwrapDek({ iv: org.wrappedDekIv, ciphertext: org.wrappedDekCiphertext, tag: org.wrappedDekTag }, orgId);
}

/** Re-wraps every org DEK (and the identity DEK) from `oldKek` to `newKek`; already-rotated rows are skipped. */
export async function rotateKek(
  host: OrgHost,
  oldKek: Buffer,
  newKek: Buffer,
): Promise<{ rewrapped: number; skipped: number; identity: IdentityRotateResult }> {
  const orgs = await host.store.listOrgs();
  let rewrapped = 0;
  let skipped = 0;
  for (const org of orgs) {
    const envelope = { iv: org.wrappedDekIv, ciphertext: org.wrappedDekCiphertext, tag: org.wrappedDekTag };
    try {
      unwrapDek(envelope, newKek, org.id);
      skipped += 1;
      continue;
    } catch {
      // still on old KEK
    }
    const dek = unwrapDek(envelope, oldKek, org.id);
    const next = wrapDek(dek, newKek, org.id);
    await host.store.updateOrgWrappedDek(org.id, {
      wrappedDekIv: next.iv,
      wrappedDekCiphertext: next.ciphertext,
      wrappedDekTag: next.tag,
    });
    rewrapped += 1;
  }
  const identity = await new IdentityKeyring(host.store, oldKek, host.now).rotateKek(oldKek, newKek);
  return { rewrapped, skipped, identity };
}
