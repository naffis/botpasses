import { decrypt, encrypt, type Envelope } from "../crypto.ts";
import type { IdentityKeyRecord, VaultStore } from "../store/types.ts";
import { generateDek, unwrapDek, wrapDek } from "./kek.ts";

/** Row id of the single identity DEK in `identity_keys`. */
export const IDENTITY_KEY_ID = "identity";

/** What an identity envelope holds; each kind gets its own AAD so envelopes cannot be swapped between slots. */
export type WrappedSecretKind = "totp" | "totp_pending";

export function secretAad(userId: string, kind: WrappedSecretKind): string {
  switch (kind) {
    case "totp":
      return userId;
    case "totp_pending":
      return `totp_pending:${userId}`;
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unhandled secret kind: ${String(_exhaustive)}`);
    }
  }
}

function envelopeOf(row: IdentityKeyRecord): Envelope {
  return { iv: row.wrappedIv, ciphertext: row.wrappedCiphertext, tag: row.wrappedTag };
}

export type UnwrapResult = {
  secret: string;
  /** Present when the envelope was still wrapped under the raw KEK; persist it to finish the migration. */
  rewrapped?: Envelope;
};

export type IdentityRotateResult = {
  dek_rewrapped: boolean;
  /** Legacy user envelopes (raw old KEK) moved under the identity DEK. */
  users_rewrapped: number;
  /** Envelopes that opened under neither key; left untouched. */
  users_unreadable: number;
};

/**
 * Identity DEK: one random 32-byte key wrapped under the KEK (AAD = row id) and created on
 * first use. Authenticator secrets are wrapped under it with AAD = user id, so KEK rotation
 * re-wraps a single row instead of every user.
 *
 * With `previousKek` (a rotation in progress, `VAULT_KEK_PREVIOUS`), a row still wrapped under
 * the previous KEK opens and is re-wrapped under the current one in place.
 */
export class IdentityKeyring {
  readonly #store: VaultStore;
  readonly #kek: Buffer;
  readonly #previousKek: Buffer | undefined;
  readonly #now: () => Date;
  #dek: Buffer | undefined;

  constructor(store: VaultStore, kek: Buffer, now: () => Date, previousKek?: Buffer) {
    this.#store = store;
    this.#kek = kek;
    this.#previousKek = previousKek;
    this.#now = now;
  }

  async dek(): Promise<Buffer> {
    if (this.#dek) return this.#dek;
    let row = await this.#store.getIdentityKey(IDENTITY_KEY_ID);
    if (!row) {
      await this.#createUnder(this.#kek);
      row = await this.#store.getIdentityKey(IDENTITY_KEY_ID);
      if (!row) throw new Error("identity key missing after insert");
    }
    this.#dek = await this.#openRow(row);
    return this.#dek;
  }

  /** Current KEK first; a row still under the previous KEK is re-wrapped under the current one. */
  async #openRow(row: IdentityKeyRecord): Promise<Buffer> {
    const envelope = envelopeOf(row);
    try {
      return unwrapDek(envelope, this.#kek, IDENTITY_KEY_ID);
    } catch (err) {
      if (!this.#previousKek) throw err;
    }
    const dek = unwrapDek(envelope, this.#previousKek, IDENTITY_KEY_ID);
    const next = wrapDek(dek, this.#kek, IDENTITY_KEY_ID);
    await this.#store.updateIdentityKey(IDENTITY_KEY_ID, {
      wrappedIv: next.iv,
      wrappedCiphertext: next.ciphertext,
      wrappedTag: next.tag,
    });
    return dek;
  }

  async wrap(userId: string, kind: WrappedSecretKind, secret: string): Promise<Envelope> {
    return encrypt(secret, await this.dek(), secretAad(userId, kind));
  }

  /** Migrate-on-read: tries the identity DEK, then the raw KEK (legacy rows, AAD = user id), then the previous raw KEK. */
  async unwrap(userId: string, kind: WrappedSecretKind, envelope: Envelope): Promise<UnwrapResult> {
    const dek = await this.dek();
    try {
      return { secret: decrypt(envelope, dek, secretAad(userId, kind)) };
    } catch {
      // Not under the identity DEK; fall through to the legacy raw-KEK envelope.
    }
    let secret: string;
    try {
      secret = decrypt(envelope, this.#kek, userId);
    } catch (err) {
      if (!this.#previousKek) throw err;
      secret = decrypt(envelope, this.#previousKek, userId);
    }
    return { secret, rewrapped: encrypt(secret, dek, secretAad(userId, kind)) };
  }

  /**
   * Re-wrap the identity DEK under `newKek` (skips when already there), creating it when the
   * table is still empty, then move any legacy user envelopes off the raw old KEK.
   */
  async rotateKek(oldKek: Buffer, newKek: Buffer): Promise<IdentityRotateResult> {
    const row = await this.#store.getIdentityKey(IDENTITY_KEY_ID);
    let dekRewrapped = false;
    let dek: Buffer;
    if (!row) {
      dek = await this.#createUnder(newKek);
      dekRewrapped = true;
    } else {
      const envelope = envelopeOf(row);
      try {
        dek = unwrapDek(envelope, newKek, IDENTITY_KEY_ID);
      } catch {
        dek = unwrapDek(envelope, oldKek, IDENTITY_KEY_ID);
        const next = wrapDek(dek, newKek, IDENTITY_KEY_ID);
        await this.#store.updateIdentityKey(IDENTITY_KEY_ID, {
          wrappedIv: next.iv,
          wrappedCiphertext: next.ciphertext,
          wrappedTag: next.tag,
        });
        dekRewrapped = true;
      }
    }
    this.#dek = dek;
    let usersRewrapped = 0;
    let usersUnreadable = 0;
    for (const user of await this.#store.listUsersWithTotp()) {
      if (!user.totpWrappedIv || !user.totpWrappedCiphertext || !user.totpWrappedTag) continue;
      const envelope: Envelope = {
        iv: user.totpWrappedIv,
        ciphertext: user.totpWrappedCiphertext,
        tag: user.totpWrappedTag,
      };
      try {
        decrypt(envelope, dek, secretAad(user.id, "totp"));
        continue;
      } catch {
        // Still a legacy envelope under the raw KEK.
      }
      let secret: string;
      try {
        secret = decrypt(envelope, oldKek, user.id);
      } catch {
        usersUnreadable += 1;
        continue;
      }
      const next = encrypt(secret, dek, secretAad(user.id, "totp"));
      await this.#store.updateUser({
        ...user,
        totpWrappedIv: next.iv,
        totpWrappedCiphertext: next.ciphertext,
        totpWrappedTag: next.tag,
      });
      usersRewrapped += 1;
    }
    return { dek_rewrapped: dekRewrapped, users_rewrapped: usersRewrapped, users_unreadable: usersUnreadable };
  }

  /** Insert a fresh DEK wrapped under `kek`; a concurrent creator wins and its key is returned. */
  async #createUnder(kek: Buffer): Promise<Buffer> {
    const fresh = generateDek();
    const wrapped = wrapDek(fresh, kek, IDENTITY_KEY_ID);
    await this.#store.insertIdentityKey({
      id: IDENTITY_KEY_ID,
      wrappedIv: wrapped.iv,
      wrappedCiphertext: wrapped.ciphertext,
      wrappedTag: wrapped.tag,
      createdAt: this.#now().toISOString(),
    });
    const row = await this.#store.getIdentityKey(IDENTITY_KEY_ID);
    if (!row) throw new Error("identity key missing after insert");
    return unwrapDek(envelopeOf(row), kek, IDENTITY_KEY_ID);
  }
}
