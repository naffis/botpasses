import { generateMasterKey, parseMasterKey } from "../../src/crypto.ts";
import { generateDek, unwrapDek, wrapDek } from "../../src/hosted/kek.ts";
import { IDENTITY_KEY_ID } from "../../src/hosted/identity-keys.ts";
import type { VaultStore } from "../../src/store/types.ts";

/**
 * One KEK for every test in this process that opens IdentityKeyring against the
 * shared CI Postgres. `identity_keys` is a singleton; a fresh random KEK per
 * test cannot unwrap a row another file already wrote.
 */
export const TEST_PLANE_KEK = parseMasterKey(generateMasterKey());

/** If the singleton is missing or wrapped under another KEK, put a TEST_PLANE_KEK row in place. */
export async function ensureSharedIdentityKey(store: VaultStore): Promise<void> {
  const row = await store.getIdentityKey(IDENTITY_KEY_ID);
  if (row) {
    try {
      unwrapDek(
        { iv: row.wrappedIv, ciphertext: row.wrappedCiphertext, tag: row.wrappedTag },
        TEST_PLANE_KEK,
        IDENTITY_KEY_ID,
      );
      return;
    } catch {
      // Leftover from another file's random KEK (identity-postgres rotation, a prior run).
    }
  }
  const wrapped = wrapDek(generateDek(), TEST_PLANE_KEK, IDENTITY_KEY_ID);
  if (row) {
    await store.updateIdentityKey(IDENTITY_KEY_ID, {
      wrappedIv: wrapped.iv,
      wrappedCiphertext: wrapped.ciphertext,
      wrappedTag: wrapped.tag,
    });
    return;
  }
  await store.insertIdentityKey({
    id: IDENTITY_KEY_ID,
    wrappedIv: wrapped.iv,
    wrappedCiphertext: wrapped.ciphertext,
    wrappedTag: wrapped.tag,
    createdAt: new Date().toISOString(),
  });
}
