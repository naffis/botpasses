/**
 * Structured logging and error reporting for the hosted process.
 *
 * Every line is one JSON object on stderr (Fly ships stderr to its log drain). Field names
 * `value`, `password`, `code`, `token`, `secret`, `authorization`, and `cookie` are dropped
 * before anything is written, so a careless caller cannot log a credential.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const DROPPED_FIELDS = new Set(["value", "password", "code", "token", "secret", "authorization", "cookie"]);

let cachedVersion: string | undefined;

/** `version` from package.json, read once. Used for Sentry `release` and MCP serverInfo. */
export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const version =
      parsed && typeof parsed === "object" && typeof (parsed as { version?: unknown }).version === "string"
        ? (parsed as { version: string }).version
        : "0.0.0";
    cachedVersion = version;
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(fields)) {
    if (DROPPED_FIELDS.has(key)) continue;
    safe[key] = val;
  }
  return safe;
}

export function logVaultEvent(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...safeFields(fields), at: new Date().toISOString() }));
}

export type RequestLogFields = {
  method: string;
  path: string;
  status: number;
  ms: number;
  requestId: string;
  /** `operator`, `model`, `trusted`, or `anon`. Never an id that identifies a person. */
  principal?: string;
};

/**
 * One line per request. Call from the HTTP layer when the response finishes:
 *   logRequest({ method, path, status: res.statusCode, ms, requestId })
 * Query strings are not logged (they can carry codes and tokens).
 */
export function logRequest(fields: RequestLogFields): void {
  logVaultEvent("request", {
    method: fields.method,
    path: fields.path.split("?")[0] ?? fields.path,
    status: fields.status,
    ms: Math.round(fields.ms),
    request_id: fields.requestId,
    ...(fields.principal ? { principal: fields.principal } : {}),
  });
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Reuse a well-formed inbound `x-request-id` (Fly sets one), otherwise mint a UUID. */
export function requestIdFrom(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["x-request-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && REQUEST_ID_RE.test(value)) return value;
  return randomUUID();
}

export type AuthEventKind =
  | "otp_sent"
  | "otp_verified"
  | "otp_failed"
  | "otp_locked"
  | "totp_verified"
  | "totp_failed"
  | "totp_locked"
  | "backup_code_used"
  | "session_revoked"
  | "signed_out"
  | "bootstrap_used";

/**
 * Authentication events, one line each, for alerting on brute force and lockouts. Emails
 * are logged as a short hash so a log line can be correlated but not read as PII.
 */
export function logAuthEvent(kind: AuthEventKind, fields: Record<string, unknown>): void {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(fields)) {
    if (key === "email" && typeof val === "string") {
      out.email_hash = createHash("sha256").update(val.trim().toLowerCase()).digest("hex").slice(0, 12);
      continue;
    }
    out[key] = val;
  }
  logVaultEvent(`auth_${kind}`, out);
}

const TOKEN_RE = /\b(avm|avt)_[A-Za-z0-9_-]+/g;
const BEARER_RE = /bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_DETAIL_RE = /Key \([^)]*\)=\([^)]*\)/g;

/** Strip machine tokens, bearer values, and pg constraint details from an error message. */
export function redactMessage(message: string): string {
  return message
    .replace(TOKEN_RE, "$1_[redacted]")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(KEY_DETAIL_RE, "Key ([redacted])")
    .slice(0, 500);
}

export type CaptureContext = {
  requestId?: string;
  path?: string;
};

export type SentryTarget = {
  url: string;
  authHeader: string;
  dsn: string;
  key: string;
  project: string;
};

export function sentryTarget(dsn: string): SentryTarget | undefined {
  try {
    const u = new URL(dsn);
    const key = u.username;
    const project = u.pathname.replace(/^\//, "");
    if (!key || !project) return undefined;
    return {
      dsn,
      key,
      project,
      url: `${u.protocol}//${u.host}/api/${project}/envelope/`,
      authHeader: `Sentry sentry_version=7, sentry_client=botpasses/${packageVersion()}, sentry_key=${key}`,
    };
  } catch {
    return undefined;
  }
}

export type SentryEnvelopeInput = {
  message: string;
  errorName: string;
  environment: string;
  release: string;
  eventId: string;
  sentAt: string;
  context?: CaptureContext;
};

/** Three newline-separated JSON lines: envelope header, item header, event payload. */
export function buildSentryEnvelope(dsn: string, input: SentryEnvelopeInput): string {
  const header = { event_id: input.eventId, sent_at: input.sentAt, dsn };
  const item = { type: "event" };
  const event = {
    event_id: input.eventId,
    timestamp: input.sentAt,
    platform: "node",
    level: "error",
    release: input.release,
    environment: input.environment,
    message: { formatted: input.message },
    exception: { values: [{ type: input.errorName, value: input.message }] },
    tags: {
      ...(input.context?.requestId ? { request_id: input.context.requestId } : {}),
      ...(input.context?.path ? { path: input.context.path } : {}),
    },
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(item)}\n${JSON.stringify(event)}\n`;
}

export const SENTRY_TIMEOUT_MS = 10_000;

/**
 * Log the error locally, then post a Sentry envelope when SENTRY_DSN is set. The message is
 * redacted before it leaves the process. Network failures are logged, never thrown.
 */
export async function captureException(
  err: unknown,
  context: CaptureContext = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const raw = err instanceof Error ? err.message : String(err);
  const message = redactMessage(raw);
  const errorName = err instanceof Error ? err.name : "Error";
  logVaultEvent("exception", { message, error: errorName, ...(context.requestId ? { request_id: context.requestId } : {}) });
  const dsn = env.SENTRY_DSN;
  if (!dsn) return;
  const target = sentryTarget(dsn);
  if (!target) return;
  const body = buildSentryEnvelope(dsn, {
    message,
    errorName,
    environment: env.VAULT_DEPLOY_PLANE ?? "local",
    release: `botpasses@${packageVersion()}`,
    eventId: randomUUID().replace(/-/g, ""),
    sentAt: new Date().toISOString(),
    context,
  });
  try {
    const res = await fetchFn(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": target.authHeader,
      },
      body,
      signal: AbortSignal.timeout(SENTRY_TIMEOUT_MS),
    });
    if (!res.ok) logVaultEvent("sentry_send_failed", { status: res.status });
  } catch (sendErr) {
    const reason = sendErr instanceof Error ? sendErr.name : "error";
    logVaultEvent("sentry_send_failed", { reason });
  }
}
