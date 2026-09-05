/**
 * AAD for hosted item envelopes. Binds the ciphertext to the item row so a DB
 * writer cannot swap ciphertexts between items or edit the plaintext
 * `allowed_hosts_json` / `inject` columns on a high-value item.
 * Rows written before binding were bound to `orgId` alone; `rebindLegacyItems` in
 * `kernel-items.ts` re-encrypts them once at boot. The read path accepts only this binding.
 */
export function itemAad(input: {
  orgId: string;
  itemId: string;
  allowedHostsJson: string;
  inject: string;
}): string {
  return `${input.orgId}|${input.itemId}|${input.allowedHostsJson}|${input.inject}`;
}

/** AAD used before item binding. Read only by the boot-time rebind, never by the inject path. */
export function legacyItemAad(orgId: string): string {
  return orgId;
}
