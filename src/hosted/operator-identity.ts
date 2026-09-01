import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { encrypt, decrypt } from "../crypto.ts";
import type { EmailOtpRecord, OperatorSessionRecord, UserRecord } from "../hosted-types.ts";
import type { VaultStore } from "../store/types.ts";
import { HttpError } from "./errors.ts";
import type { EmailSender } from "./email.ts";
import * as OTPAuth from "otpauth";

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
const BACKUP_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type IdentityOpts = {
  store: VaultStore;
  sessionSecret: string;
  kek: Buffer;
  sendEmail?: EmailSender;
  now?: () => Date;
};

export type CookieOpts = { secure: boolean };

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

function mintBackup(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out += BACKUP_CHARSET[(bytes[i] ?? 0) % BACKUP_CHARSET.length];
  }
  return out;
}

export class IpWindowLimiter {
  readonly #hits = new Map<string, number[]>();
  allow(key: string, max: number, windowMs: number, now: number): boolean {
    const cutoff = now - windowMs;
    const prev = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (prev.length >= max) {
      this.#hits.set(key, prev);
      return false;
    }
    prev.push(now);
    this.#hits.set(key, prev);
    return true;
  }
}

export function totpEnabled(user: UserRecord): boolean {
  return Boolean(user.totpWrappedIv && user.totpWrappedCiphertext && user.totpLastStep !== null);
}

export class OperatorIdentity {
  readonly store: VaultStore;
  readonly sessionSecret: string;
  readonly #kek: Buffer;
  readonly sendEmail: EmailSender | undefined;
  readonly now: () => Date;
  readonly ipLimiter = new IpWindowLimiter();
  readonly pendingTotp = new Map<string, { secret: string; at: number }>();

  constructor(opts: IdentityOpts) {
    this.store = opts.store;
    this.sessionSecret = opts.sessionSecret;
    this.#kek = opts.kek;
    this.sendEmail = opts.sendEmail;
    this.now = opts.now ?? (() => new Date());
  }

  clientIp(forwarded: string | undefined, remote: string | undefined): string {
    const first = forwarded?.split(",")[0]?.trim();
    return first || remote || "0.0.0.0";
  }

  async sendOtp(emailRaw: string, ip: string): Promise<{ ok: true }> {
    const email = normalizeEmail(emailRaw);
    const now = this.now();
    const nowMs = now.getTime();
    if (!this.ipLimiter.allow(`ip:${ip}`, OTP_IP_MAX, OTP_EMAIL_WINDOW_MS, nowMs)) {
      throw new HttpError(429, "Too many requests");
    }
    const since = new Date(nowMs - OTP_EMAIL_WINDOW_MS).toISOString();
    const sent = await this.store.countEmailOtpSince(email, since);
    if (sent >= OTP_EMAIL_MAX) throw new HttpError(429, "Too many requests");
    const code = mintOtp();
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
        await this.sendEmail(
          email,
          "Your Botpasses sign-in code",
          `<p>Your sign-in code expires in 10 minutes.</p><p>${code}</p>`,
        );
      } catch {
        throw new HttpError(503, "Email delivery failed");
      }
    }
    return { ok: true };
  }

  /** Test-only: peek latest OTP by verifying a supplied code against the store hash. */
  async debugOtpMatches(email: string, code: string): Promise<boolean> {
    const ch = await this.store.latestEmailOtp(normalizeEmail(email));
    if (!ch) return false;
    return scryptVerify(code, ch.codeScrypt);
  }

  async verifyOtp(
    emailRaw: string,
    otp: string,
    cookies: CookieOpts,
  ): Promise<{ cookies: string[]; user: UserRecord; sessionToken: string }> {
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
      throw new HttpError(401, "Invalid code");
    }
    await this.store.updateEmailOtp({ ...ch, expiresAt: now.toISOString(), attempts: ch.attempts });
    let user = await this.store.getUserByEmail(email);
    if (!user) {
      user = {
        id: `usr_${randomUUID()}`,
        email,
        emailVerifiedAt: now.toISOString(),
        totpWrappedIv: null,
        totpWrappedCiphertext: null,
        totpWrappedTag: null,
        totpLastStep: null,
        createdAt: now.toISOString(),
      };
      await this.store.insertUser(user);
    } else if (!user.emailVerifiedAt) {
      user = { ...user, emailVerifiedAt: now.toISOString() };
      await this.store.updateUser(user);
    }
    return this.#issueSession(user, cookies);
  }

  async startTotp(userId: string): Promise<{ otpauth_url: string }> {
    const user = await this.store.getUser(userId);
    if (!user) throw new HttpError(401, "Authentication required");
    const secret = new OTPAuth.Secret({ size: 20 });
    this.pendingTotp.set(userId, { secret: secret.base32, at: this.now().getTime() });
    const totp = new OTPAuth.TOTP({
      issuer: "Botpasses",
      label: user.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });
    return { otpauth_url: totp.toString() };
  }

  async confirmTotp(
    userId: string,
    code: string,
    cookies: CookieOpts,
  ): Promise<{ cookies: string[]; backup_codes?: string[]; user: UserRecord }> {
    const user = await this.store.getUser(userId);
    if (!user) throw new HttpError(401, "Authentication required");
    const pending = this.pendingTotp.get(userId);
    if (pending && this.now().getTime() - pending.at < OTP_TTL_MS) {
      this.#assertTotp(pending.secret, code.trim(), user.totpLastStep);
      const wrapped = encrypt(pending.secret, this.#kek, user.id);
      const step = currentStep(this.now());
      const next: UserRecord = {
        ...user,
        totpWrappedIv: wrapped.iv,
        totpWrappedCiphertext: wrapped.ciphertext,
        totpWrappedTag: wrapped.tag,
        totpLastStep: step,
      };
      await this.store.updateUser(next);
      this.pendingTotp.delete(userId);
      const backups: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const raw = mintBackup();
        backups.push(raw);
        await this.store.insertBackupCode(user.id, await scryptHash(raw));
      }
      const issued = await this.#issueSession(next, cookies);
      return { ...issued, backup_codes: backups, user: next };
    }
    if (user.totpWrappedIv && user.totpWrappedCiphertext && user.totpWrappedTag) {
      const secret = decrypt(
        { iv: user.totpWrappedIv, ciphertext: user.totpWrappedCiphertext, tag: user.totpWrappedTag },
        this.#kek,
        user.id,
      );
      try {
        this.#assertTotp(secret, code.trim(), user.totpLastStep);
      } catch (err) {
        if (await this.#useBackup(user.id, code.trim())) {
          return { ...(await this.#issueSession(user, cookies)), user };
        }
        throw err;
      }
      const step = usedStep(this.now(), code.trim(), secret);
      await this.store.updateUser({ ...user, totpLastStep: step });
      return { ...(await this.#issueSession(user, cookies)), user };
    }
    throw new HttpError(400, "TOTP enrollment not started");
  }

  async loadSession(cookieHeader: string | undefined, secure: boolean): Promise<{
    user: UserRecord;
    session: OperatorSessionRecord;
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

  async #issueSession(
    user: UserRecord,
    cookies: CookieOpts,
  ): Promise<{ cookies: string[]; user: UserRecord; sessionToken: string }> {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const row: OperatorSessionRecord = {
      idHash: hashToken(token),
      userId: user.id,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_IDLE_MS).toISOString(),
    };
    await this.store.insertSession(row);
    return { cookies: this.sessionCookies(token, cookies), user, sessionToken: token };
  }

  #assertTotp(secretBase32: string, code: string, lastStep: number | null): void {
    const totp = new OTPAuth.TOTP({
      issuer: "Botpasses",
      label: "operator",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
    const delta = totp.validate({ token: code, timestamp: this.now().getTime(), window: 1 });
    if (delta === null) throw new HttpError(401, "Invalid code");
    const step = Math.floor(this.now().getTime() / 30000) + delta;
    if (lastStep !== null && step === lastStep) throw new HttpError(401, "Invalid code");
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

function currentStep(now: Date): number {
  return Math.floor(now.getTime() / 30000);
}

function usedStep(now: Date, code: string, secretBase32: string): number {
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  const delta = totp.validate({ token: code, timestamp: now.getTime(), window: 1 }) ?? 0;
  return Math.floor(now.getTime() / 30000) + delta;
}
