import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import type { UserRecord } from "../hosted-types.ts";
import type { UserSecurityState } from "../store/types.ts";

export const TOTP_PERIOD_S = 30;
export const TOTP_MAX_FAILURES = 10;
export const TOTP_LOCK_MS = 15 * 60 * 1000;
/** How long an in-flight enrollment secret stays confirmable. */
export const TOTP_PENDING_TTL_MS = 10 * 60 * 1000;
export const BACKUP_CODE_COUNT = 10;
const BACKUP_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BACKUP_LEN = 10;

export function totpEnabled(user: UserRecord): boolean {
  return Boolean(user.totpWrappedIv && user.totpWrappedCiphertext && user.totpLastStep !== null);
}

export function newTotpSecret(): OTPAuth.Secret {
  return new OTPAuth.Secret({ size: 20 });
}

export function otpauthUrl(secret: OTPAuth.Secret, email: string): string {
  return new OTPAuth.TOTP({
    issuer: "Botpasses",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_S,
    secret,
  }).toString();
}

export function currentStep(nowMs: number): number {
  return Math.floor(nowMs / (TOTP_PERIOD_S * 1000));
}

/** The time step the code matches (window of one step either side), or null when it does not. */
export function matchTotpStep(secretBase32: string, code: string, nowMs: number): number | null {
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_S,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  const delta = totp.validate({ token: code, timestamp: nowMs, window: 1 });
  if (delta === null) return null;
  return currentStep(nowMs) + delta;
}

/** Structural shape check so a 6-digit entry never spends scrypt work on backup codes. */
export function looksLikeTotpCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Uppercases and strips separators so pasted `abcd-efgh-jk` matches the issued code. */
export function normalizeBackupCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export function mintBackupCode(): string {
  const bytes = randomBytes(BACKUP_LEN);
  let out = "";
  for (let i = 0; i < BACKUP_LEN; i += 1) {
    out += BACKUP_CHARSET[(bytes[i] ?? 0) % BACKUP_CHARSET.length];
  }
  return out;
}

/** Milliseconds until the authenticator lock lifts; 0 when not locked. */
export function lockRemainingMs(state: Pick<UserSecurityState, "totpLockedUntil">, nowMs: number): number {
  if (!state.totpLockedUntil) return 0;
  const until = Date.parse(state.totpLockedUntil);
  if (Number.isNaN(until)) return 0;
  return Math.max(0, until - nowMs);
}

export function securityOf(user: UserSecurityState): UserSecurityState {
  return {
    totpFailures: user.totpFailures,
    totpLockedUntil: user.totpLockedUntil,
    totpPendingWrappedIv: user.totpPendingWrappedIv,
    totpPendingWrappedCiphertext: user.totpPendingWrappedCiphertext,
    totpPendingWrappedTag: user.totpPendingWrappedTag,
    totpPendingAt: user.totpPendingAt,
  };
}

export function withoutPending(state: UserSecurityState): UserSecurityState {
  return {
    ...state,
    totpPendingWrappedIv: null,
    totpPendingWrappedCiphertext: null,
    totpPendingWrappedTag: null,
    totpPendingAt: null,
  };
}

/** The live in-flight enrollment envelope, or undefined when none or expired. */
export function pendingEnvelope(
  state: UserSecurityState,
  nowMs: number,
): { iv: string; ciphertext: string; tag: string } | undefined {
  if (!state.totpPendingWrappedIv || !state.totpPendingWrappedCiphertext || !state.totpPendingWrappedTag) {
    return undefined;
  }
  if (!state.totpPendingAt) return undefined;
  const at = Date.parse(state.totpPendingAt);
  if (Number.isNaN(at) || nowMs - at >= TOTP_PENDING_TTL_MS) return undefined;
  return {
    iv: state.totpPendingWrappedIv,
    ciphertext: state.totpPendingWrappedCiphertext,
    tag: state.totpPendingWrappedTag,
  };
}
