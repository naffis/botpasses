/**
 * Scoped approvals (plan 3.1): the shapes an agent's stated call and an operator's limits take,
 * validation of both against the item, and the check a connector call runs against a grant's
 * scope. Pure functions; `kernel-grants.ts` calls them and re-exports the public ones.
 */
import { unscopedFields, type GrantPolicy, type GrantScope, type ItemRecord, type RequestedScope } from "../hosted-types.ts";
import { HttpError } from "./errors.ts";
import { ALLOWED_METHODS, assertAllowedHostname, canonicalRequestPath } from "./ssrf.ts";

export const SESSION_TTL_MS = 8 * 3600 * 1000;
/** `ttl_seconds` bounds: one minute up to a day for `session`, up to a year for standing policies. */
export const TTL_MIN_SECONDS = 60;
export const SESSION_TTL_MAX_SECONDS = 86_400;
export const STANDING_TTL_MAX_SECONDS = 365 * 86_400;
export const MAX_CALLS_CAP = 1_000_000;

/** The call an agent says it will make. Any field may be omitted. */
export type GrantRequest = { host?: string; method?: string; path?: string };

/** The call a connector is about to make; every field known. */
export type ConnectorCall = { host: string; method: string; path: string };

/**
 * Operator-supplied limits on approve. Present dimensions are used as given; absent dimensions
 * are unrestricted. Omit the whole object to inherit the requested scope.
 */
export type ScopeInput = {
  methods?: string[];
  pathPrefixes?: string[];
  hosts?: string[];
  maxCalls?: number;
  ttlSeconds?: number;
};

export type ScopeDenial = "method" | "path" | "host";

export function itemHosts(item: Pick<ItemRecord, "allowedHostsJson">): string[] {
  const v: unknown = JSON.parse(item.allowedHostsJson);
  if (!Array.isArray(v) || v.some((h) => typeof h !== "string")) {
    throw new HttpError(500, "Corrupt allowed_hosts");
  }
  return v as string[];
}

function normalizeMethod(raw: string, field: string): string {
  const method = raw.trim().toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new HttpError(400, `${field} must be one of ${[...ALLOWED_METHODS].join(", ")}`);
  }
  return method;
}

/**
 * The canonical request path (`canonicalRequestPath`): what `requested_scope` stores, the inbox
 * card shows, and the connector sends. Its 400 names the field the caller passed.
 */
function normalizePath(raw: string, field: string): string {
  try {
    return canonicalRequestPath(raw);
  } catch (err) {
    const why = err instanceof HttpError ? err.message.replace(/^path /, "") : "must be a path starting with /";
    throw new HttpError(400, `${field} ${why}`);
  }
}

/** Path as the origin will see it, without its query; undefined when it cannot be canonicalised. */
function canonicalPrefix(path: string): string | undefined {
  try {
    return pathPrefixOf(canonicalRequestPath(path));
  } catch {
    return undefined;
  }
}

/** Prefix match on segment boundaries: `/v1/read` covers `/v1/read` and `/v1/read/x`, not `/v1/readwrite`. */
export function pathWithinPrefix(path: string, prefix: string): boolean {
  if (prefix === "/" || path === prefix) return true;
  const boundary = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path.startsWith(boundary);
}

function normalizeHost(raw: string, allowed: string[], field: string): string {
  const host = raw.trim().toLowerCase();
  assertAllowedHostname(host, [host]);
  if (!allowed.includes(host)) {
    throw new HttpError(400, `host_mismatch: ${host} is not in allowed_hosts`, {
      status: "host_mismatch",
      host,
      allowed_hosts: allowed,
      field,
    });
  }
  return host;
}

/** Validates the agent's stated call against the item. Empty request reads as no scope. */
export function requestedScopeFor(request: GrantRequest | undefined, item: ItemRecord): RequestedScope | null {
  if (!request) return null;
  const host = request.host?.trim() ? normalizeHost(request.host, itemHosts(item), "host") : null;
  const method = request.method?.trim() ? normalizeMethod(request.method, "method") : null;
  const path = request.path?.trim() ? normalizePath(request.path, "path") : null;
  if (host === null && method === null && path === null) return null;
  return { host, method, path };
}

/** Path without its query, and without a trailing slash so `/v1/` and `/v1` are one prefix. */
function pathPrefixOf(path: string): string {
  const q = path.indexOf("?");
  const bare = q === -1 ? path : path.slice(0, q);
  const trimmed = bare.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

/**
 * Resolves the scope an approval writes. An explicit `scope` is validated as given; without one
 * the grant narrows to what the agent asked for (host, method, path prefix), else it is
 * unrestricted, which is what every approval was before 3.1. Hosts never widen past the item.
 */
export function resolveApprovalScope(input: {
  scope: ScopeInput | undefined;
  requested: RequestedScope | null;
  item: Pick<ItemRecord, "allowedHostsJson">;
  policy: GrantPolicy;
  now: Date;
}): GrantScope & { expiresAt: string | null } {
  const allowed = itemHosts(input.item);
  const scope = input.scope;
  const base = unscopedFields();
  let methods: string[] | null = null;
  let pathPrefixes: string[] | null = null;
  let hosts: string[] | null = null;
  let maxCalls: number | null = null;
  if (scope) {
    if (scope.methods !== undefined) {
      if (scope.methods.length === 0) throw new HttpError(400, "scope.methods must not be empty");
      methods = uniq(scope.methods.map((m) => normalizeMethod(m, "scope.methods")));
    }
    if (scope.pathPrefixes !== undefined) {
      if (scope.pathPrefixes.length === 0) throw new HttpError(400, "scope.path_prefixes must not be empty");
      pathPrefixes = uniq(scope.pathPrefixes.map((p) => pathPrefixOf(normalizePath(p, "scope.path_prefixes"))));
    }
    if (scope.hosts !== undefined) {
      if (scope.hosts.length === 0) throw new HttpError(400, "scope.hosts must not be empty");
      hosts = uniq(scope.hosts.map((h) => h.trim().toLowerCase()));
      const outside = hosts.filter((h) => !allowed.includes(h));
      if (outside.length > 0) {
        throw new HttpError(400, "scope.hosts must be a subset of the item's allowed hosts", {
          hosts: outside,
          allowed_hosts: allowed,
        });
      }
    }
    if (scope.maxCalls !== undefined) {
      if (!Number.isInteger(scope.maxCalls) || scope.maxCalls < 1 || scope.maxCalls > MAX_CALLS_CAP) {
        throw new HttpError(400, `scope.max_calls must be an integer from 1 to ${MAX_CALLS_CAP}`);
      }
      maxCalls = scope.maxCalls;
    }
  } else if (input.requested) {
    methods = input.requested.method ? [input.requested.method] : null;
    pathPrefixes = input.requested.path ? [pathPrefixOf(input.requested.path)] : null;
    if (input.requested.host) {
      if (!allowed.includes(input.requested.host)) {
        throw new HttpError(400, "The requested host is no longer in the item's allowed hosts; deny and ask again", {
          hosts: [input.requested.host],
          allowed_hosts: allowed,
        });
      }
      hosts = [input.requested.host];
    }
  }
  const ttlMax = input.policy === "session" ? SESSION_TTL_MAX_SECONDS : STANDING_TTL_MAX_SECONDS;
  let ttlMs: number | null = input.policy === "session" ? SESSION_TTL_MS : null;
  if (scope?.ttlSeconds !== undefined) {
    if (!Number.isInteger(scope.ttlSeconds) || scope.ttlSeconds < TTL_MIN_SECONDS || scope.ttlSeconds > ttlMax) {
      throw new HttpError(400, `scope.ttl_seconds must be an integer from ${TTL_MIN_SECONDS} to ${ttlMax}`);
    }
    ttlMs = scope.ttlSeconds * 1000;
  }
  return {
    ...base,
    methods,
    pathPrefixes,
    hosts,
    maxCalls,
    expiresAt: ttlMs === null ? null : new Date(input.now.getTime() + ttlMs).toISOString(),
  };
}

/** Why a scoped grant refuses this call, or `undefined` when the call fits. */
export function scopeDenialReason(scope: GrantScope, call: ConnectorCall): ScopeDenial | undefined {
  if (scope.methods && !scope.methods.includes(call.method.toUpperCase())) return "method";
  if (scope.hosts && !scope.hosts.includes(call.host.toLowerCase())) return "host";
  if (pathDenied(scope, call.path)) return "path";
  return undefined;
}

/**
 * Whether an existing grant or standing policy satisfies a `request_grant` call. No stated
 * request (the agent named only the item) is treated as covered, which is the pre-scope
 * behaviour. Present host, method, and path dimensions must each fit; omitted ones are
 * not checked.
 */
export function requestFitsGrant(scope: GrantScope, requested: RequestedScope | null): boolean {
  if (!requested) return true;
  if (requested.method && scope.methods && !scope.methods.includes(requested.method)) return false;
  if (requested.host && scope.hosts && !scope.hosts.includes(requested.host)) return false;
  if (requested.path && pathDenied(scope, requested.path)) return false;
  return true;
}

function pathDenied(scope: GrantScope, path: string): boolean {
  if (!scope.pathPrefixes) return false;
  const canonical = canonicalPrefix(path);
  if (canonical === undefined) return true;
  return !scope.pathPrefixes.some((prefix) => {
    const admitted = canonicalPrefix(prefix);
    return admitted !== undefined && pathWithinPrefix(canonical, admitted);
  });
}
