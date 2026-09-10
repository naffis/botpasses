import { createHmac, hkdfSync } from "node:crypto";
import type { Envelope } from "../crypto.ts";
import type { InviteRecord, UserRow, VaultStore } from "../store/types.ts";
import type { IdentityKeyring } from "./identity-keys.ts";
import { logVaultEvent } from "./observe.ts";

export const EMAIL_LOOKUP_INFO = "botpasses/email-lookup/v1";

export function isLegacyPlaintextEmail(value: string): boolean {
  return value.includes("@");
}

export function emailLookupKey(dek: Buffer, normalized: string): string {
  const key = Buffer.from(hkdfSync("sha256", dek, "", EMAIL_LOOKUP_INFO, 32));
  return createHmac("sha256", key).update(`email:${normalized}`).digest("hex");
}

export class EmailDirectory {
  readonly #keys: IdentityKeyring;

  constructor(keys: IdentityKeyring) {
    this.#keys = keys;
  }

  async lookupKey(normalized: string): Promise<string> {
    return emailLookupKey(await this.#keys.dek(), normalized);
  }

  async wrapUser(userId: string, normalized: string): Promise<Envelope> {
    return this.#keys.wrap(userId, "email", normalized);
  }

  async wrapInvite(inviteId: string, normalized: string): Promise<Envelope> {
    return this.#keys.wrap(inviteId, "invite_email", normalized);
  }

  async revealUser(user: UserRow): Promise<string> {
    if (isLegacyPlaintextEmail(user.email)) return user.email;
    if (!user.emailWrappedIv || !user.emailWrappedCiphertext || !user.emailWrappedTag) {
      logVaultEvent("email_unwrap_failed", { user_id: user.id });
      return "";
    }
    try {
      const opened = await this.#keys.unwrap(user.id, "email", {
        iv: user.emailWrappedIv,
        ciphertext: user.emailWrappedCiphertext,
        tag: user.emailWrappedTag,
      });
      return opened.secret;
    } catch {
      logVaultEvent("email_unwrap_failed", { user_id: user.id });
      return "";
    }
  }

  async revealInvite(invite: InviteRecord): Promise<string> {
    if (isLegacyPlaintextEmail(invite.email)) return invite.email;
    if (!invite.emailWrappedIv || !invite.emailWrappedCiphertext || !invite.emailWrappedTag) {
      logVaultEvent("email_unwrap_failed", { invite_id: invite.id });
      return "";
    }
    try {
      const opened = await this.#keys.unwrap(invite.id, "invite_email", {
        iv: invite.emailWrappedIv,
        ciphertext: invite.emailWrappedCiphertext,
        tag: invite.emailWrappedTag,
      });
      return opened.secret;
    } catch {
      logVaultEvent("email_unwrap_failed", { invite_id: invite.id });
      return "";
    }
  }
}

export async function persistUserEmail(
  store: VaultStore,
  emails: EmailDirectory,
  user: UserRow,
  normalized: string,
): Promise<UserRow> {
  const hmac = await emails.lookupKey(normalized);
  const wrap = await emails.wrapUser(user.id, normalized);
  const next: UserRow = {
    ...user,
    email: hmac,
    emailWrappedIv: wrap.iv,
    emailWrappedCiphertext: wrap.ciphertext,
    emailWrappedTag: wrap.tag,
  };
  await store.updateUser(next);
  return next;
}

export async function persistInviteEmail(
  store: VaultStore,
  emails: EmailDirectory,
  invite: InviteRecord,
  normalized: string,
): Promise<void> {
  const hmac = await emails.lookupKey(normalized);
  const wrap = await emails.wrapInvite(invite.id, normalized);
  await store.updateInviteEmail(invite.id, {
    email: hmac,
    emailWrappedIv: wrap.iv,
    emailWrappedCiphertext: wrap.ciphertext,
    emailWrappedTag: wrap.tag,
  });
}

export async function restorePlaintextEmails(
  store: VaultStore,
  emails: EmailDirectory,
  shouldStop: () => boolean,
): Promise<{ users: number; invites: number }> {
  let users = 0;
  let invites = 0;
  for (const user of await store.listAllUsers()) {
    if (shouldStop()) break;
    if (isLegacyPlaintextEmail(user.email)) continue;
    const inbox = await emails.revealUser(user);
    if (!inbox) continue;
    await store.updateUser({ ...user, email: inbox });
    users += 1;
  }
  for (const invite of await store.listAllInvites()) {
    if (shouldStop()) break;
    if (isLegacyPlaintextEmail(invite.email)) continue;
    const inbox = await emails.revealInvite(invite);
    if (!inbox || !invite.emailWrappedIv || !invite.emailWrappedCiphertext || !invite.emailWrappedTag) continue;
    await store.updateInviteEmail(invite.id, {
      email: inbox,
      emailWrappedIv: invite.emailWrappedIv,
      emailWrappedCiphertext: invite.emailWrappedCiphertext,
      emailWrappedTag: invite.emailWrappedTag,
    });
    invites += 1;
  }
  return { users, invites };
}

export async function rebindLegacyEmails(
  store: VaultStore,
  emails: EmailDirectory,
  shouldStop: () => boolean,
): Promise<{ users: number; invites: number }> {
  let users = 0;
  let invites = 0;
  for (const user of await store.listUsersWithLegacyEmail()) {
    if (shouldStop()) break;
    if (!isLegacyPlaintextEmail(user.email)) continue;
    await persistUserEmail(store, emails, user, user.email.trim().toLowerCase());
    users += 1;
  }
  for (const invite of await store.listInvitesWithLegacyEmail()) {
    if (shouldStop()) break;
    if (!isLegacyPlaintextEmail(invite.email)) continue;
    await persistInviteEmail(store, emails, invite, invite.email.trim().toLowerCase());
    invites += 1;
  }
  return { users, invites };
}
