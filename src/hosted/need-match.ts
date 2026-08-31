import type { FindItemSummary, FindItemsResult, ItemRecord, VaultEnvName } from "../hosted-types.ts";

function parseHosts(json: string): string[] {
  const v: unknown = JSON.parse(json);
  if (!Array.isArray(v) || v.some((h) => typeof h !== "string")) return [];
  return v as string[];
}

export function toFindSummary(environment: VaultEnvName, item: ItemRecord): FindItemSummary {
  return {
    name: item.name,
    kind: item.kind,
    last4: item.last4,
    allowed_hosts: parseHosts(item.allowedHostsJson).map((h) => h.toLowerCase()),
    inject: item.inject,
    environment,
  };
}

export function matchFindItems(input: {
  environment: VaultEnvName;
  items: ItemRecord[];
  itemName?: string;
  host?: string;
}): Extract<FindItemsResult, { status: "found" | "ambiguous" | "host_mismatch" }> | { status: "none" } {
  const host = input.host?.toLowerCase();
  const named = input.itemName
    ? input.items.find((i) => i.name === input.itemName)
    : undefined;
  const andMatches = input.items.filter((i) => {
    if (input.itemName && i.name !== input.itemName) return false;
    if (host && !parseHosts(i.allowedHostsJson).map((h) => h.toLowerCase()).includes(host)) {
      return false;
    }
    return Boolean(input.itemName || host);
  });

  if (input.itemName && host && named && andMatches.length === 0) {
    return { status: "host_mismatch", item: toFindSummary(input.environment, named) };
  }

  if (andMatches.length === 0) return { status: "none" };
  if (andMatches.length === 1) {
    const only = andMatches[0];
    if (!only) return { status: "none" };
    return { status: "found", item: toFindSummary(input.environment, only) };
  }
  const sorted = [...andMatches].sort((a, b) => a.name.localeCompare(b.name));
  const sliced = sorted.slice(0, 5);
  return {
    status: "ambiguous",
    items: sliced.map((i) => toFindSummary(input.environment, i)),
    truncated: sorted.length > 5,
  };
}

export const NEED_ITEM_MESSAGE =
  "Open this Botpasses URL, sign in, and enter the credential there. Never paste the secret into chat.";
