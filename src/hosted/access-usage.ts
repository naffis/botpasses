import type { AccessEventRecord, HostedAuditRecord } from "../hosted-types.ts";

export type AccessUsage = {
  created_at: string | null;
  first_access_at: string | null;
  last_access_at: string | null;
  fetched: string[];
};

/** ISO-8601 timestamps from `Date.toISOString()` sort lexicographically. */
export function minIso(values: readonly (string | null | undefined)[]): string | null {
  let min: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (min === null || value < min) min = value;
  }
  return min;
}

export function maxIso(values: readonly (string | null | undefined)[]): string | null {
  let max: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

export function injectsFor(
  audit: readonly HostedAuditRecord[],
  clientId: string,
  itemName?: string,
): HostedAuditRecord[] {
  return audit.filter((row) => {
    if (row.action !== "inject") return false;
    if (row.clientId !== clientId) return false;
    if (itemName && row.itemName !== itemName) return false;
    return Boolean(row.itemName);
  });
}

/** Newest-first unique item names this client injected. Names only, never values. */
export function fetchedNames(
  audit: readonly HostedAuditRecord[],
  clientId: string,
  itemName?: string,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of injectsFor(audit, clientId, itemName)) {
    const name = row.itemName;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function clientUsage(
  client: { lastTokenAt: string | null; lastSeenAt: string | null },
  events: readonly AccessEventRecord[],
  audit: readonly HostedAuditRecord[],
  clientId: string,
): AccessUsage {
  const issued = events.filter((e) => e.clientId === clientId).map((e) => e.issuedAt);
  const injectAt = injectsFor(audit, clientId).map((row) => row.at);
  return {
    created_at: minIso([...issued, client.lastTokenAt]),
    first_access_at: minIso([...injectAt, client.lastSeenAt]),
    last_access_at: maxIso([...injectAt, client.lastSeenAt]),
    fetched: fetchedNames(audit, clientId),
  };
}

export function grantUsage(
  grant: { createdAt: string; approvedAt: string | null; consumedAt: string | null },
  audit: readonly HostedAuditRecord[],
  clientId: string,
  itemName: string,
): AccessUsage {
  const injectAt = injectsFor(audit, clientId, itemName).map((row) => row.at);
  return {
    created_at: grant.createdAt,
    first_access_at: minIso([...injectAt, grant.consumedAt]),
    last_access_at: maxIso([...injectAt, grant.consumedAt]),
    fetched: fetchedNames(audit, clientId, itemName),
  };
}

export function sessionUsage(session: { createdAt: string; lastSeenAt: string }): AccessUsage {
  return {
    created_at: session.createdAt,
    first_access_at: session.createdAt,
    last_access_at: session.lastSeenAt,
    fetched: [],
  };
}
