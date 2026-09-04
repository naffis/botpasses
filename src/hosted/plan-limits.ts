/**
 * Plan limits (task 3.9). One free tier today; the limits are data so a paid tier is a new
 * entry, not new code. `VAULT_PLAN_LIMITS_JSON` overrides individual free-tier values, for
 * example `{"credentials":100,"calls":50000}`.
 *
 * `calls` counts `inject` audit rows for the org since the first of the current UTC month.
 * `orgs` is per user, not per org: how many orgs one account may own.
 */
import { HttpError } from "./errors.ts";

export type PlanLimitKind = "credentials" | "agents" | "members" | "calls" | "orgs";

/** Kinds counted against one org (the plan report); `orgs` is counted per user instead. */
export type OrgUsageKind = Exclude<PlanLimitKind, "orgs">;

const PLAN_LIMIT_KINDS: readonly PlanLimitKind[] = ["credentials", "agents", "members", "calls", "orgs"];

export type PlanLimits = Record<PlanLimitKind, number>;

export type PlanName = "free";

export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  free: { credentials: 25, agents: 10, members: 3, calls: 5000, orgs: 10 },
};

export const PLAN_LIMITS_ENV = "VAULT_PLAN_LIMITS_JSON";

function isKind(key: string): key is PlanLimitKind {
  return (PLAN_LIMIT_KINDS as readonly string[]).includes(key);
}

/**
 * Parse the env override. Unknown keys and non-positive or non-integer values are rejected
 * loudly: a typo in a limit must not silently become "unlimited" or "zero".
 */
export function parsePlanLimitsOverride(raw: string | undefined): Partial<PlanLimits> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${PLAN_LIMITS_ENV} must be a JSON object`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${PLAN_LIMITS_ENV} must be a JSON object`);
  }
  const out: Partial<PlanLimits> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isKind(key)) throw new Error(`${PLAN_LIMITS_ENV}: unknown limit "${key}"`);
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`${PLAN_LIMITS_ENV}: "${key}" must be a positive integer`);
    }
    out[key] = value;
  }
  return out;
}

/** Effective limits for `plan`, with the env override applied on top. */
export function planLimits(plan: PlanName = "free", env: NodeJS.ProcessEnv = process.env): PlanLimits {
  return { ...PLAN_LIMITS[plan], ...parsePlanLimitsOverride(env[PLAN_LIMITS_ENV]) };
}

/** 402 with a machine-readable body: `{ error: "plan_limit", kind, limit }`. */
export class PlanLimitError extends HttpError {
  readonly kind: PlanLimitKind;
  readonly limit: number;
  constructor(kind: PlanLimitKind, limit: number) {
    super(402, "plan_limit", { kind, limit });
    this.name = "PlanLimitError";
    this.kind = kind;
    this.limit = limit;
  }
}

/**
 * Throws when adding one more `kind` would exceed the limit. `current` is the count before
 * the addition, so `current === limit` is already full.
 */
export function assertWithinLimit(kind: PlanLimitKind, current: number, limits: PlanLimits = planLimits()): void {
  const limit = limits[kind];
  if (current >= limit) throw new PlanLimitError(kind, limit);
}

/** First instant of the current UTC month, the window for the monthly call budget. */
export function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export type PlanUsage = Record<OrgUsageKind, number>;

export type PlanReport = {
  plan: PlanName;
  limits: PlanLimits;
  usage: PlanUsage;
  period_start: string;
};
