const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const ACTOR_ID = /^[a-z][a-z0-9_-]{0,127}$/;

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

/** Structural hostname → env-var name. Not semantic classification. */
export function suggestedNameFromHost(host: string): string | undefined {
  const raw = host.trim().toLowerCase();
  if (!raw) return undefined;
  const candidate = raw.split(".").filter(Boolean).join("_").toUpperCase();
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
