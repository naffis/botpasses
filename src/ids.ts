import { createHash } from "node:crypto";

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const ACTOR_ID = /^[a-z][a-z0-9_-]{0,127}$/;

/** ISO-8601 timestamp for store rows and public records. */
export function nowIso(d: Date): string {
  return d.toISOString();
}

/** Lowercase hex SHA-256; the one hash behind every `*_hash` column, fingerprint, and asset tag. */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeSecretName(name: string): string {
  const n = name.trim().toUpperCase();
  if (!SECRET_NAME.test(n)) {
    throw new Error(
      "Secret names must match [A-Z][A-Z0-9_]{0,127} (env-var style).",
    );
  }
  return n;
}

export function normalizeActorId(id: string, kind: "agent" | "tool"): string {
  const n = id.trim().toLowerCase();
  if (!ACTOR_ID.test(n)) {
    throw new Error(`${kind} id must match [a-z][a-z0-9_-]{0,127}`);
  }
  return n;
}

export function last4(value: string): string {
  if (value.length < 4) return "****";
  return value.slice(-4);
}

/**
 * Structural hostname → env-var name. Not semantic classification. Every character outside
 * `[A-Z0-9]` becomes `_`, runs collapse, ends are trimmed, and a leading digit gets an `H_`
 * prefix, so any non-empty host yields a valid name (`api-v2.example.com` → `API_V2_EXAMPLE_COM`,
 * `1password.com` → `H_1PASSWORD_COM`).
 */
export function suggestedNameFromHost(host: string): string | undefined {
  const raw = host.trim().toUpperCase();
  if (!raw) return undefined;
  const compact = raw.replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  if (!compact) return undefined;
  const candidate = /^[0-9]/.test(compact) ? `H_${compact}` : compact;
  try {
    return normalizeSecretName(candidate);
  } catch {
    return undefined;
  }
}

export function maskLast4(suffix: string): string {
  return `••••${suffix}`;
}

export function parseTtlSeconds(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const m = /^(\d+)([smhd])?$/.exec(raw.trim());
  if (!m) {
    throw new Error("TTL must look like 30s, 15m, 8h, or 1d");
  }
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const mul =
    unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mul;
}
