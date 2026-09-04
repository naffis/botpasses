/**
 * AAD for hosted item envelopes. Binds the ciphertext to the item row so a DB
 * writer cannot swap ciphertexts between items or edit the plaintext
 * `allowed_hosts_json` / `inject` columns on a high-value item.
 * Legacy rows were bound to `orgId` alone; `HostedKernel.decryptItem` migrates them on read.
 */
export function itemAad(input: {
  orgId: string;
  itemId: string;
  allowedHostsJson: string;
  inject: string;
}): string {
  return `${input.orgId}|${input.itemId}|${input.allowedHostsJson}|${input.inject}`;
}

/** AAD used before item binding. Kept only for migrate-on-read. */
export function legacyItemAad(orgId: string): string {
  return orgId;
}
