import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { EmailOtpRecord, UserRecord } from "../hosted-types.ts";
import type { OperatorSessionRow, UserRow, VaultStore } from "../store/types.ts";
import { HttpError } from "./errors.ts";
import type { EmailSender } from "./email.ts";
import { buildOtpEmail } from "./otp-email.ts";
import { otpauthQrSvg } from "./totp-qr.ts";
import { IdentityKeyring } from "./identity-keys.ts";
import { IpWindowLimiter, clientIpFrom } from "./identity-limiter.ts";
import {
  BACKUP_CODE_COUNT,
  afterTotpFailure,
  afterTotpSuccess,
  attemptsRemaining,
  lockRemainingMs,
  looksLikeTotpCode,
  matchTotpStep,
  mintBackupCode,
  newTotpSecret,
  normalizeBackupCode,
  otpauthUrl,
  pendingEnvelope,
  securityOf,
  totpEnabled,
  withoutPending,
} from "./identity-totp.ts";

export { IpWindowLimiter, totpEnabled };

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const;

function scryptKey(value: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(value, salt, 32, SCRYPT_OPTS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_EMAIL_WINDOW_MS = 15 * 60 * 1000;
const OTP_EMAIL_MAX = 5;
const OTP_IP_MAX = 10;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_ABS_MS = 7 * 24 * 60 * 60 * 1000;

/** Same text for known and unknown addresses (AC-22): the response must not reveal accounts. */
export const OTP_SENT_MESSAGE =
  "Check your inbox for an 8-digit code. It stays valid for 10 minutes; a code already sent is not replaced.";

export type IdentityOpts = {
  store: VaultStore;
  sessionSecret: string;
  kek: Buffer;
  sendEmail?: EmailSender;
  now?: () => Date;
};

export type CookieOpts = { secure: boolean };

export type IssuedSession = { cookies: string[]; user: UserRow; sessionToken: string };

export type AccountSummary = {
  email: string;
  totp_enabled: boolean;
  backup_codes_remaining: number;
  created_at: string;
};

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-bp_session" : "bp_session";
}

export function csrfCookieName(secure: boolean): string {
  return secure ? "__Host-bp_csrf" : "bp_csrf";
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new HttpError(400, "Invalid email");
  }
  return email;
}

export async function scryptHash(value: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptKey(value, salt);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function scryptVerify(value: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const key = await scryptKey(value, salt);
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function signCsrf(secret: string, raw: string): string {
  return `${raw}.${hmac(secret, raw)}`;
}

export function verifyCsrfToken(secret: string, cookieVal: string | undefined, headerVal: string | undefined): void {
  if (!cookieVal || !headerVal) throw new HttpError(403, "CSRF required");
  if (cookieVal.length !== headerVal.length || !timingSafeEqual(Buffer.from(cookieVal), Buffer.from(headerVal))) {
    throw new HttpError(403, "CSRF required");
  }
  const dot = cookieVal.lastIndexOf(".");
  if (dot < 1) throw new HttpError(403, "CSRF required");
  const raw = cookieVal.slice(0, dot);
  const sig = cookieVal.slice(dot + 1);
  const expected = hmac(secret, raw);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new HttpError(403, "CSRF required");
  }
}

function cookieBase(secure: boolean, httpOnly: boolean, maxAge: number): string {
  const parts = ["Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function setCookieHeader(name: string, value: string, secure: boolean, httpOnly: boolean, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; ${cookieBase(secure, httpOnly, maxAgeSec)}`;
}

export function clearCookieHeader(name: string, secure: boolean, httpOnly: boolean): string {
  return `${name}=; ${cookieBase(secure, httpOnly, 0)}`;
}

function mintOtp(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, "0");
}

function otpChallengeLive(row: EmailOtpRecord | undefined, nowMs: number): boolean {
  if (!row) return false;
  if (Date.parse(row.expiresAt) <= nowMs) return false;
  return row.attempts < OTP_MAX_ATTEMPTS;
}

function lockedError(remainingMs: number): HttpError {
  return new HttpError(429, "Too many attempts", { retry_after: Math.ceil(remainingMs / 1000) });
}

export class OperatorIdentity {
  readonly store: VaultStore;
  readonly sessionSecret: string;
  readonly sendEmail: EmailSender | undefined;
  readonly now: () => Date;
  readonly ipLimiter = new IpWindowLimiter();
  readonly keys: IdentityKeyring;

  constructor(opts: IdentityOpts) {
    this.store = opts.store;
    this.sessionSecret = opts.sessionSecret;
    this.sendEmail = opts.sendEmail;
    this.now = opts.now ?? (() => new Date());
    this.keys = new IdentityKeyring(opts.store, opts.kek, this.now);
  }

  /**
   * Header-only variant kept for `http.ts`, which cannot see `Fly-Client-IP` from here.
   * Prefer `requestClientIp(req)` from `identity-limiter.ts`.
   */
  clientIp(forwarded: string | undefined, remote: string | undefined): string {
    return clientIpFrom(undefined, forwarded, remote);
  }

  /** Same `{ ok: true, message }` for unknown emails. Does not send again while a code is still valid. */
  async sendOtp(emailRaw: string, ip: string): Promise<{ ok: true; message: string }> {
    const email = normalizeEmail(emailRaw);
    const now = this.now();
    const nowMs = now.getTime();
    const existing = await this.store.latestEmailOtp(email);
    if (otpChallengeLive(existing, nowMs)) {
      return { ok: true, message: OTP_SENT_MESSAGE };
    }
    if (!this.ipLimiter.allow(`ip:${ip}`, OTP_IP_MAX, OTP_EMAIL_WINDOW_MS, nowMs)) {
      throw new HttpError(429, "Too many requests");
    }
    const since = new Date(nowMs - OTP_EMAIL_WINDOW_MS).toISOString();
    const sent = await this.store.countEmailOtpSince(email, since);
    if (sent >= OTP_EMAIL_MAX) throw new HttpError(429, "Too many requests");
    const code = mintOtp();
    const mail = buildOtpEmail(code, OTP_TTL_MS / 60_000);
    const row: EmailOtpRecord = {
      id: `otp_${randomUUID()}`,
      email,
      codeScrypt: await scryptHash(code),
      expiresAt: new Date(nowMs + OTP_TTL_MS).toISOString(),
      attempts: 0,
      sentAt: now.toISOString(),
    };
    await this.store.insertEmailOtp(row);
    if (this.sendEmail) {
      try {
        await this.sendEmail(email, mail.subject, mail.html, mail.text);
      } catch {
        throw new HttpError(503, "Email delivery failed");
      }
    }
    return { ok: true, message: OTP_SENT_MESSAGE };
  }

  /** Test-only: peek latest OTP by verifying a supplied code against the store hash. */
  async debugOtpMatches(email: string, code: string): Promise<boolean> {
    const ch = await this.store.latestEmailOtp(normalizeEmail(email));
    if (!ch) return false;
    return scryptVerify(code, ch.codeScrypt);
  }

  /** Email step. Issues a session with `mfaAt` null; the authenticator step upgrades it. */
  async verifyOtp(emailRaw: string, otp: string, cookies: CookieOpts): Promise<IssuedSession> {
    const email = normalizeEmail(emailRaw);
    const ch = await this.store.latestEmailOtp(email);
    const now = this.now();
    if (!ch || Date.parse(ch.expiresAt) <= now.getTime()) {
      throw new HttpError(401, "Invalid code");
    }
    if (ch.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(401, "Invalid code");
    const ok = await scryptVerify(otp.trim(), ch.codeScrypt);
    if (!ok) {
      const attempts = ch.attempts + 1;
      const expiresAt = attempts >= OTP_MAX_ATTEMPTS ? now.toISOString() : ch.expiresAt;
      await this.store.updateEmailOtp({ ...ch, attempts, expiresAt });
      throw new HttpError(401, "Invalid code", { attempts_remaining: Math.max(0, OTP_MAX_ATTEMPTS - attempts) });
    }
    await this.store.updateEmailOtp({ ...ch, expiresAt: now.toISOString(), attempts: ch.attempts });
    let user = await this.store.getUserByEmail(email);
    if (!user) {
      const fresh: UserRecord = {
        id: `usr_${randomUUID()}`,
        email,
        emailVerifiedAt: now.toISOString(),
        totpWrappedIv: null,
        totpWrappedCiphertext: null,
        totpWrappedTag: null,
        totpLastStep: null,
        createdAt: now.toISOString(),
      };
      await this.store.insertUser(fresh);
      user = await this.store.getUser(fresh.id);
      if (!user) throw new HttpError(500, "User missing after insert");
    } else if (!user.emailVerifiedAt) {
      user = { ...user, emailVerifiedAt: now.toISOString() };
      await this.store.updateUser(user);
    }
    return this.#issueSession(user, cookies, null);
  }

  /**
   * Begin (or restart) authenticator enrollment. An enrolled user must present a current code
   * (`currentCode`, authenticator or backup) from a session that already passed the step.
   * The pending secret is stored wrapped so a restart or second machine can confirm it.
   */
  async startTotp(
    userId: string,
    input: { currentCode?: string; sessionReady: boolean },
  ): Promise<{ otpauth_url: string; qr_svg: string }> {
    let user = await this.store.getUser(userId);
    if (!user) throw new HttpError(401, "Authentication required");
    if (totpEnabled(user)) {
      if (!input.sessionReady) throw new HttpError(403, "mfa_required", { verify_url: "/verify-totp" });
      const code = input.currentCode?.trim() ?? "";
      if (!code) throw new HttpError(403, "current_code_required");
      user = await this.#checkFactor(user, code);
    }
    const secret = newTotpSecret();
    const wrapped = await this.keys.wrap(user.id, "totp_pending", secret.base32);
    await this.store.updateUserSecurity(user.id, {
      ...securityOf(user),
      totpPendingWrappedIv: wrapped.iv,
      totpPendingWrappedCiphertext: wrapped.ciphertext,
      totpPendingWrappedTag: wrapped.tag,
      totpPendingAt: this.now().toISOString(),
    });
    const otpauth_url = otpauthUrl(secret, user.email);
    return { otpauth_url, qr_svg: otpauthQrSvg(otpauth_url) };
  }

  /**
   * Confirm the pending secret. Replaces the confirmed secret, drops unused backup codes and
   * issues a new set, rotates the current session into an MFA-passed one and deletes the
   * user's other pre-MFA sessions.
   */
  async confirmTotp(
    userId: string,
    sessionHash: string,
    code: string,
    cookies: CookieOpts,
  ): Promise<IssuedSession & { backup_codes: string[] }> {
    const user = await this.store.getUser(userId);
    if (!user) throw new HttpError(401, "Authentication required");
    const nowMs = this.now().getTime();
    const pending = pendingEnvelope(user, nowMs);
    if (!pending) throw new HttpError(400, "Authenticator enrollment not started");
    const remaining = lockRemainingMs(user, nowMs);
    if (remaining > 0) throw lockedError(remaining);
    const { secret } = await this.keys.unwrap(user.id, "totp_pending", pending);
    const step = matchTotpStep(secret, code.trim(), nowMs);
    if (step === null) throw await this.#recordFailure(user, nowMs);
    const wrapped = await this.keys.wrap(user.id, "totp", secret);
    const next: UserRow = {
      ...user,
      totpWrappedIv: wrapped.iv,
      totpWrappedCiphertext: wrapped.ciphertext,
      totpWrappedTag: wrapped.tag,
      totpLastStep: step,
      ...withoutPending(afterTotpSuccess(securityOf(user))),
    };
    await this.store.updateUser(next);
    await this.store.updateUserSecurity(next.id, securityOf(next));
    await this.store.deleteUnusedBackupCodes(next.id);
    const backups = await this.#mintBackups(next.id);
    const issued = await this.#rotateSession(next, sessionHash, cookies);
    return { ...issued, backup_codes: backups };
  }

  /** Sign-in authenticator step: authenticator code or backup code, then a fresh MFA-passed session. */
  async verifyTotp(userId: string, sessionHash: string, code: string, cookies: CookieOpts): Promise<IssuedSession> {
    const user = await this.store.getUser(userId);
    if (!user) throw new HttpError(401, "Authentication required");
    if (!totpEnabled(user)) throw new HttpError(400, "Authenticator not enrolled", { enroll_url: "/enroll-totp" });
    const checked = await this.#checkFactor(user, code);
    return this.#rotateSession(checked, sessionHash, cookies);
  }

  /** Replaces every unused backup code after a current authenticator or backup code. Shown once. */
  async regenerateBackupCodes(userId: string, code: string): Promise<{ backup_codes: string[] }> {
    const user = await this.store.getUser(userId);
    if (!user) throw new HttpError(401, "Authentication required");
    if (!totpEnabled(user)) throw new HttpError(400, "Authenticator not enrolled", { enroll_url: "/enroll-totp" });
    await this.#checkFactor(user, code);
    await this.store.deleteUnusedBackupCodes(user.id);
    return { backup_codes: await this.#mintBackups(user.id) };
  }

  async accountSummary(userId: string): Promise<AccountSummary> {
    const user = await this.store.getUser(userId);
    if (!user) throw new HttpError(404, "Unknown user");
    const codes = await this.store.listBackupCodes(user.id);
    return {
      email: user.email,
      totp_enabled: totpEnabled(user),
      backup_codes_remaining: codes.filter((c) => c.usedAt === null).length,
      created_at: user.createdAt,
    };
  }

  /** Re-wrap the identity DEK (and any legacy raw-KEK authenticator secrets) under `newKek`. */
  async rotateKek(oldKek: Buffer, newKek: Buffer): Promise<void> {
    await this.keys.rotateKek(oldKek, newKek);
  }

  async loadSession(cookieHeader: string | undefined, secure: boolean): Promise<{
    user: UserRow;
    session: OperatorSessionRow;
    token: string;
  } | undefined> {
    const cookies = parseCookies(cookieHeader);
    const token = cookies[sessionCookieName(secure)] ?? cookies[sessionCookieName(false)];
    if (!token) return undefined;
    const session = await this.store.getSession(hashToken(token));
    if (!session) return undefined;
    const now = this.now().getTime();
    if (Date.parse(session.expiresAt) <= now) {
      await this.store.deleteSession(session.idHash);
      return undefined;
    }
    const created = Date.parse(session.createdAt);
    if (now - created > SESSION_ABS_MS) {
      await this.store.deleteSession(session.idHash);
      return undefined;
    }
    const user = await this.store.getUser(session.userId);
    if (!user) return undefined;
    const lastSeen = this.now().toISOString();
    const idleExp = new Date(now + SESSION_IDLE_MS).toISOString();
    await this.store.touchSession(session.idHash, lastSeen, idleExp);
    return { user, session: { ...session, lastSeenAt: lastSeen, expiresAt: idleExp }, token };
  }

  sessionCookies(token: string, cookies: CookieOpts): string[] {
    const maxAge = Math.floor(SESSION_IDLE_MS / 1000);
    const csrf = signCsrf(this.sessionSecret, randomBytes(32).toString("base64url"));
    return [
      setCookieHeader(sessionCookieName(cookies.secure), token, cookies.secure, true, maxAge),
      setCookieHeader(csrfCookieName(cookies.secure), csrf, cookies.secure, false, maxAge),
    ];
  }

  logoutCookies(secure: boolean): string[] {
    return [
      clearCookieHeader(sessionCookieName(secure), secure, true),
      clearCookieHeader(csrfCookieName(secure), secure, false),
    ];
  }

  assertCsrf(cookieHeader: string | undefined, csrfHeader: string | undefined, secure: boolean): void {
    const cookies = parseCookies(cookieHeader);
    const cookieVal = cookies[csrfCookieName(secure)] ?? cookies[csrfCookieName(false)];
    verifyCsrfToken(this.sessionSecret, cookieVal, csrfHeader);
  }

  async #issueSession(user: UserRow, cookies: CookieOpts, mfaAt: string | null): Promise<IssuedSession> {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const row: OperatorSessionRow = {
      idHash: hashToken(token),
      userId: user.id,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_IDLE_MS).toISOString(),
      mfaAt,
    };
    await this.store.insertSession(row);
    return { cookies: this.sessionCookies(token, cookies), user, sessionToken: token };
  }

  /** Swap `currentHash` for a fresh MFA-passed session and drop the user's other pre-MFA sessions. */
  async #rotateSession(user: UserRow, currentHash: string, cookies: CookieOpts): Promise<IssuedSession> {
    await this.store.deleteSession(currentHash);
    const issued = await this.#issueSession(user, cookies, this.now().toISOString());
    await this.store.deletePendingSessions(user.id, hashToken(issued.sessionToken));
    return issued;
  }

  /**
   * Check an authenticator code (6 digits, replay-protected) or a backup code against the
   * confirmed secret, under the failure counter. Returns the user row with the consumed step
   * and reset counter persisted. Throws 429 while locked, 401 with `attempts_remaining` otherwise.
   */
  async #checkFactor(user: UserRow, rawCode: string): Promise<UserRow> {
    const nowMs = this.now().getTime();
    const remaining = lockRemainingMs(user, nowMs);
    if (remaining > 0) throw lockedError(remaining);
    const code = rawCode.trim();
    if (looksLikeTotpCode(code)) {
      const { secret, user: current } = await this.#totpSecret(user);
      const step = matchTotpStep(secret, code, nowMs);
      if (step !== null && step !== current.totpLastStep) {
        const next: UserRow = { ...current, totpLastStep: step, ...afterTotpSuccess(securityOf(current)) };
        await this.store.updateUser(next);
        await this.store.updateUserSecurity(next.id, securityOf(next));
        return next;
      }
      throw await this.#recordFailure(current, nowMs);
    }
    if (await this.#useBackup(user.id, normalizeBackupCode(code))) {
      const next: UserRow = { ...user, ...afterTotpSuccess(securityOf(user)) };
      await this.store.updateUserSecurity(next.id, securityOf(next));
      return next;
    }
    throw await this.#recordFailure(user, nowMs);
  }

  async #recordFailure(user: UserRow, nowMs: number): Promise<HttpError> {
    const next = afterTotpFailure(securityOf(user), nowMs);
    await this.store.updateUserSecurity(user.id, next);
    const locked = lockRemainingMs(next, nowMs);
    if (locked > 0) return lockedError(locked);
    return new HttpError(401, "Invalid code", { attempts_remaining: attemptsRemaining(next) });
  }

  /** Confirmed secret via the keyring; a legacy raw-KEK envelope is re-wrapped and persisted here. */
  async #totpSecret(user: UserRow): Promise<{ secret: string; user: UserRow }> {
    if (!user.totpWrappedIv || !user.totpWrappedCiphertext || !user.totpWrappedTag) {
      throw new HttpError(400, "Authenticator not enrolled", { enroll_url: "/enroll-totp" });
    }
    const { secret, rewrapped } = await this.keys.unwrap(user.id, "totp", {
      iv: user.totpWrappedIv,
      ciphertext: user.totpWrappedCiphertext,
      tag: user.totpWrappedTag,
    });
    if (!rewrapped) return { secret, user };
    const migrated: UserRow = {
      ...user,
      totpWrappedIv: rewrapped.iv,
      totpWrappedCiphertext: rewrapped.ciphertext,
      totpWrappedTag: rewrapped.tag,
    };
    await this.store.updateUser(migrated);
    return { secret, user: migrated };
  }

  async #mintBackups(userId: string): Promise<string[]> {
    const backups: string[] = [];
    for (let i = 0; i < BACKUP_CODE_COUNT; i += 1) {
      const raw = mintBackupCode();
      backups.push(raw);
      await this.store.insertBackupCode(userId, await scryptHash(raw));
    }
    return backups;
  }

  async #useBackup(userId: string, code: string): Promise<boolean> {
    const rows = await this.store.listBackupCodes(userId);
    for (const row of rows) {
      if (row.usedAt) continue;
      if (await scryptVerify(code, row.codeScrypt)) {
        await this.store.markBackupUsed(userId, row.codeScrypt, this.now().toISOString());
        return true;
      }
    }
    return false;
  }
}
