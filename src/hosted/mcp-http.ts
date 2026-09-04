import type { HostedGrantStatus, VaultEnvName } from "../hosted-types.ts";
import { normalizeSecretName } from "../ids.ts";
import {
  clampTimeoutMs,
  executeConnector,
  redactConnectorBody,
  type ConnectorFetch,
  type ConnectorItem,
  type ConnectorOpts,
  type ConnectorResult,
} from "./connector.ts";
import { HttpError, isHttpError, isInjectDenied, isNeedItemError, isScopeDenied, type NeedItemPayload } from "./errors.ts";
import type { HostedKernel, InjectOutcome } from "./kernel.ts";
import type { ModelPrincipal } from "./auth.ts";
import {
  clientIdRequiredHint,
  emptyOriginHint,
  isClientSecretShaped,
  itemWithAccessToken,
  mintClientCredentials,
  mintFailedHint,
  readMintedAccessToken,
  refreshAccessToken,
  refreshItemName,
  resolveClientId,
} from "./providers/oauth.ts";
import { isApiHost, isTokenPath, providerForHost, userPathHint } from "./providers/registry.ts";
import { cachedMint, storeMint } from "./providers/token-cache.ts";
import type { Provider } from "./providers/types.ts";
import { injectModeOf } from "./store-form-fields.ts";

export type ConnectorCallDeps = {
  kernel: HostedKernel;
  principal: ModelPrincipal;
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
};

export type ConnectorTarget = {
  itemName?: string;
  host?: string;
  method: string;
  path: string;
  taskDescription?: string;
  clientId?: string;
  contentType?: string;
  /** Origin deadline in ms, already clamped. */
  timeoutMs: number;
  /** Explain what would happen without calling the origin or consuming a grant. */
  dryRun: boolean;
};

type ScopeDeniedPayload = Record<string, unknown> & { status: "scope_denied"; item_name: string; hint: string };

type GrantHalt = {
  grant_id: string;
  status: string;
  approval_code?: string;
  notify_failed: boolean;
  item_name: string;
};

/** Origin result as the model sees it. `status` duplicates `origin_status` for one release. */
export type OriginPayload = {
  origin_status: number;
  /** @deprecated Use `origin_status`; `status` collides with vault status strings. */
  status: number;
  body: string;
  origin_headers: Record<string, string>;
  hint?: string;
  [extra: string]: unknown;
};

export type DryRunReport = {
  dry_run: true;
  item_name: string | null;
  host: string;
  method: string;
  path: string;
  would_send: boolean;
  reason: string;
  grant_status: "standing" | HostedGrantStatus | "none";
  inject_mode: string | null;
  provider: string | null;
};

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function required(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Missing required string argument: ${key}`);
  }
  return value.trim();
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new HttpError(400, `${key} must be true or false`);
  return value;
}

/**
 * Accept path as `/v1/me` or a full https URL. Host may be a hostname or a URL.
 * Structural URL parsing only (format), not semantic classification.
 */
export function connectorTargetFromArgs(args: Record<string, unknown>): ConnectorTarget {
  const method = required(args, "method").toUpperCase();
  let path = required(args, "path");
  let host = optional(args.host)?.trim();
  const itemName = optional(args.item_name)?.trim();
  const taskDescription = optional(args.task_description);
  const clientId = optional(args.client_id);
  const contentType = optional(args.content_type);
  const timeoutMs = clampTimeoutMs(args.timeout_ms);
  const dryRun = optionalBoolean(args, "dry_run");

  if (path.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(path);
    } catch {
      throw new HttpError(400, "path must start with / or be an https URL");
    }
    if (parsed.protocol !== "https:") {
      throw new HttpError(400, "path URL must be https");
    }
    host = host || parsed.hostname;
    path = parsed.pathname + parsed.search;
  }
  if (host && (host.includes("://") || host.includes("/"))) {
    try {
      const u = new URL(host.includes("://") ? host : `https://${host}`);
      host = u.hostname;
      if (path === "/" && u.pathname && u.pathname !== "/") path = u.pathname + u.search;
    } catch {
      throw new HttpError(400, "host must be a hostname such as api.example.com");
    }
  }
  if (host) host = host.toLowerCase();
  if (!itemName && !host) {
    throw new HttpError(
      400,
      "http_request requires item_name or host, plus method and path. Example: host=api.example.com method=GET path=/v1/me",
    );
  }
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new HttpError(400, "path must start with /");
  }
  return { itemName, host, method, path, taskDescription, clientId, contentType, timeoutMs, dryRun };
}

export function retryFields(target: ConnectorTarget, itemName?: string): Record<string, string> {
  const retry: Record<string, string> = { method: target.method, path: target.path };
  if (target.host) retry.host = target.host;
  const name = itemName ?? target.itemName;
  if (name) retry.item_name = name;
  if (target.clientId) retry.client_id = target.clientId;
  if (target.contentType) retry.content_type = target.contentType;
  return retry;
}

function withRetry(payload: unknown, target: ConnectorTarget, itemName?: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return { ...payload, retry: retryFields(target, itemName) };
}

function isPreparedConnector(value: unknown): value is ConnectorItem {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.secret === "string" && Array.isArray(rec.allowedHosts);
}

function originPayload(origin: ConnectorResult, extra: Record<string, unknown> = {}): OriginPayload {
  const given = typeof extra.hint === "string" ? extra.hint : undefined;
  const hint = given ?? (origin.body.trim() ? undefined : emptyOriginHint(origin.status));
  return {
    origin_status: origin.status,
    status: origin.status,
    body: origin.body,
    origin_headers: origin.headers,
    ...extra,
    ...(hint ? { hint } : {}),
  };
}

function connectorOpts(deps: ConnectorCallDeps, target: ConnectorTarget, redact = true): ConnectorOpts {
  return {
    fetchImpl: deps.fetchImpl,
    resolveAddresses: deps.resolveAddresses,
    timeoutMs: target.timeoutMs,
    ...(redact ? {} : { redact: false }),
  };
}

async function releaseGrantOnFailure(
  kernel: HostedKernel,
  item: ConnectorItem,
  originStatus?: number,
): Promise<void> {
  if (originStatus !== undefined && originStatus >= 200 && originStatus < 300) return;
  if (item.grantPolicy === "prompt") {
    await kernel.reactivatePromptGrant(item.grantId);
  }
}

/** Host the request will go to when the caller named only the item: its first allowed host. */
async function hostForItem(deps: ConnectorCallDeps, itemName: string, environment: VaultEnvName): Promise<string | undefined> {
  const stored = await deps.kernel.findStoredItem(deps.principal.orgId, environment, itemName);
  if (!stored) return undefined;
  const hosts: unknown = JSON.parse(stored.allowedHostsJson);
  return Array.isArray(hosts) && typeof hosts[0] === "string" ? hosts[0] : undefined;
}

export async function runHttpRequest(
  deps: ConnectorCallDeps,
  args: Record<string, unknown>,
  environment: VaultEnvName,
): Promise<unknown> {
  const target = connectorTargetFromArgs(args);
  if (target.dryRun) return dryRun(deps, target, environment);
  let itemName = target.itemName;
  if (!itemName && target.host) {
    const found = await deps.kernel.findItems({
      orgId: deps.principal.orgId,
      clientId: deps.principal.clientId,
      environment,
      host: target.host,
      taskDescription: target.taskDescription,
    });
    if (found.status !== "found") return withRetry(found, target);
    itemName = found.item.name;
  }
  if (!itemName) {
    throw new HttpError(400, "http_request requires item_name or host");
  }
  const requestHost = target.host ?? (await hostForItem(deps, itemName, environment)) ?? "";
  await deps.kernel.assertCallBudget(deps.principal.orgId);
  const prepared = await prepareOrGrant(deps, {
    itemName,
    environment,
    taskDescription: target.taskDescription,
    request: { host: requestHost, method: target.method, path: target.path },
  });
  if (!isPreparedConnector(prepared)) return withRetry(prepared, target, itemName);
  const audit = (outcome: InjectOutcome) =>
    deps.kernel.auditInject(deps.principal.orgId, deps.principal.clientId, prepared.name, outcome);
  try {
    const result = await dispatchConnector(deps, prepared, target, args, environment);
    if (sentToOrigin(result)) {
      await releaseGrantOnFailure(deps.kernel, prepared, result.origin_status);
      await audit("inject");
    } else {
      await audit("inject_denied");
    }
    return withRetry(result, target, itemName);
  } catch (err) {
    await releaseGrantOnFailure(deps.kernel, prepared);
    // 400-class connector errors (host mismatch, blocked address, unusable mode) stop the send;
    // anything else means the credential left the process but the origin did not answer.
    const stopped = isHttpError(err) && (err.status === 400 || err.message === "inject_unsupported");
    await audit(stopped ? "inject_denied" : "inject_failed");
    throw err;
  }
}

/** `originPayload` shape: the request reached the origin and got an HTTP status back. */
function sentToOrigin(result: unknown): result is OriginPayload {
  if (!result || typeof result !== "object") return false;
  const rec = result as { origin_status?: unknown; body?: unknown };
  return typeof rec.origin_status === "number" && typeof rec.body === "string";
}

function shouldMintClientCredentials(provider: Provider, host: string, item: ConnectorItem, target: ConnectorTarget): boolean {
  if (!isApiHost(provider, host)) return false;
  if (!provider.grantTypes.includes("client_credentials")) return false;
  return isClientSecretShaped(item) || Boolean(target.clientId);
}

async function dispatchConnector(
  deps: ConnectorCallDeps,
  item: ConnectorItem,
  target: ConnectorTarget,
  args: Record<string, unknown>,
  environment: VaultEnvName,
): Promise<unknown> {
  const host = target.host ?? item.allowedHosts[0] ?? "";
  const provider = providerForHost(host);
  const clientId = resolveClientId(item, target.clientId);
  const request = { method: target.method, path: target.path, host, body: args.body, contentType: target.contentType };

  if (provider && isTokenPath(provider, host, target.path)) {
    return tokenEndpointCall(deps, provider, item, target, args, host, clientId);
  }

  const hint = provider ? userPathHint(provider, host, target.path) : undefined;
  if (provider && hint) {
    const user = await tryUserToken(deps, provider, item, target, args, environment, host, hint.message);
    if (user) return user;
  }

  if (provider && shouldMintClientCredentials(provider, host, item, target)) {
    if (!clientId) {
      return { status: 400, error: "client_id_required", hint: clientIdRequiredHint(provider) };
    }
    const minted = await ensureAppToken(deps, provider, item, clientId, target);
    if ("origin_status" in minted) return minted;
    const origin = await executeConnector(itemWithAccessToken(item, minted.accessToken), request, connectorOpts(deps, target));
    const extra: Record<string, unknown> = { minted: true, token_last4: minted.last4 };
    if (origin.status === 401 && hint) extra.hint = hint.message;
    return originPayload(origin, extra);
  }

  const origin = await executeConnector(item, request, connectorOpts(deps, target));
  if (origin.status === 401 && hint) return originPayload(origin, { hint: hint.message });
  return originPayload(origin);
}

/**
 * The model posts to the provider token endpoint itself. The connector places the client secret
 * per `provider.tokenAuth`; a successful client_credentials mint is cached for later API calls.
 */
async function tokenEndpointCall(
  deps: ConnectorCallDeps,
  provider: Provider,
  item: ConnectorItem,
  target: ConnectorTarget,
  args: Record<string, unknown>,
  host: string,
  clientId: string | undefined,
): Promise<OriginPayload> {
  const tokenItem: ConnectorItem = { ...item, username: clientId ?? item.username };
  const body = args.body === undefined || args.body === null ? { grant_type: "client_credentials" } : args.body;
  const grantType =
    body && typeof body === "object" && "grant_type" in body ? String((body as { grant_type?: unknown }).grant_type) : "";
  const origin = await executeConnector(
    tokenItem,
    {
      method: target.method,
      path: target.path,
      host,
      body,
      contentType: target.contentType ?? "application/x-www-form-urlencoded",
    },
    connectorOpts(deps, target, false),
  );
  const redact = (extra: string[] = []) => redactConnectorBody(origin.body, item, extra, host);
  if (origin.status >= 200 && origin.status < 300 && clientId && grantType === "client_credentials") {
    try {
      const minted = readMintedAccessToken(origin.body);
      storeMint(deps.principal.orgId, item.itemId ?? item.name, clientId, "client_credentials", minted);
      return originPayload({ ...origin, body: redact([minted.accessToken]) }, { minted: true, token_last4: minted.last4 });
    } catch {
      return originPayload({ ...origin, body: redact() });
    }
  }
  return originPayload({ ...origin, body: redact() });
}

async function ensureAppToken(
  deps: ConnectorCallDeps,
  provider: Provider,
  item: ConnectorItem,
  clientId: string,
  target: ConnectorTarget,
): Promise<{ accessToken: string; last4: string } | OriginPayload> {
  const itemKey = item.itemId ?? item.name;
  const cached = cachedMint(deps.principal.orgId, itemKey, clientId, "client_credentials");
  if (cached) return { accessToken: cached.accessToken, last4: cached.last4 };
  const { minted, origin } = await mintClientCredentials(provider, item, clientId, connectorOpts(deps, target));
  if (origin.status < 200 || origin.status >= 300 || !minted.accessToken) {
    return originPayload(origin, { hint: mintFailedHint(provider) });
  }
  storeMint(deps.principal.orgId, itemKey, clientId, "client_credentials", minted);
  return { accessToken: minted.accessToken, last4: minted.last4 };
}

/**
 * A path that needs a user token: exchange the stored `<ITEM>_REFRESH` item (if the org has
 * one) for an access token and call with that. Returns undefined when there is no refresh item
 * or this client may not use it, so the caller falls back to the app-token path and its hint.
 */
async function tryUserToken(
  deps: ConnectorCallDeps,
  provider: Provider,
  item: ConnectorItem,
  target: ConnectorTarget,
  args: Record<string, unknown>,
  environment: VaultEnvName,
  host: string,
  hintMessage: string,
): Promise<OriginPayload | undefined> {
  const refreshName = refreshItemName(item.name);
  const stored = await deps.kernel.findStoredItem(deps.principal.orgId, environment, refreshName);
  if (!stored) return undefined;
  try {
    const refreshItem = await deps.kernel.prepareConnector({
      orgId: deps.principal.orgId,
      clientId: deps.principal.clientId,
      itemName: refreshName,
      environment,
      auditAfterSend: true,
      request: { host: provider.tokenHost, method: "POST", path: provider.tokenPath },
    });
    const clientId = resolveClientId(refreshItem, target.clientId) ?? resolveClientId(item, target.clientId);
    if (!clientId) return undefined;
    const refreshKey = refreshItem.itemId ?? refreshName;
    let cached = cachedMint(deps.principal.orgId, refreshKey, clientId, "refresh_token");
    if (!cached) {
      const { minted, origin } = await refreshAccessToken(provider, refreshItem, clientId, connectorOpts(deps, target));
      await deps.kernel.auditInject(deps.principal.orgId, deps.principal.clientId, refreshName, "inject");
      if (origin.status < 200 || origin.status >= 300 || !minted.accessToken) {
        await deps.kernel.reactivatePromptGrant(refreshItem.grantId);
        return originPayload(origin, { hint: hintMessage });
      }
      storeMint(deps.principal.orgId, refreshKey, clientId, "refresh_token", minted);
      cached = minted;
    }
    const origin = await executeConnector(
      itemWithAccessToken(item, cached.accessToken),
      { method: target.method, path: target.path, host, body: args.body, contentType: target.contentType },
      connectorOpts(deps, target),
    );
    if (origin.status < 200 || origin.status >= 300) {
      await deps.kernel.reactivatePromptGrant(refreshItem.grantId);
    }
    return originPayload(origin, { user_token: true, token_last4: cached.last4 });
  } catch (err) {
    if (isNeedItemError(err) || isInjectDenied(err)) {
      return undefined;
    }
    throw err;
  }
}

async function prepareOrGrant(
  deps: ConnectorCallDeps,
  input: {
    itemName: string;
    environment: VaultEnvName;
    taskDescription?: string;
    request: { host: string; method: string; path: string };
  },
): Promise<ConnectorItem | NeedItemPayload | GrantHalt | ScopeDeniedPayload> {
  const { kernel, principal } = deps;
  const prepare = () =>
    kernel.prepareConnector({
      orgId: principal.orgId,
      clientId: principal.clientId,
      itemName: input.itemName,
      environment: input.environment,
      auditAfterSend: true,
      request: input.request,
    });
  try {
    return await prepare();
  } catch (err) {
    if (isNeedItemError(err)) return err.payload;
    if (isScopeDenied(err)) {
      // The approval stays active for the calls it covers; do not request a new grant here.
      return {
        ...err.extra,
        item_name: input.itemName,
        hint: "This approval does not cover that method, host, or path. Ask for a new approval for this call.",
      } as ScopeDeniedPayload;
    }
    if (isInjectDenied(err)) {
      const result = await kernel.requestGrant({
        orgId: principal.orgId,
        clientId: principal.clientId,
        itemName: input.itemName,
        environment: input.environment,
        taskDescription: input.taskDescription,
        request: input.request,
      });
      if (result.grant.status === "active") return prepare();
      return {
        grant_id: result.grant.id,
        status: result.grant.status,
        approval_code: result.code,
        notify_failed: result.notifyFailed ?? false,
        item_name: input.itemName,
      };
    }
    throw err;
  }
}

/**
 * Resolve the item and grant exactly as a real call would, then report instead of sending.
 * Reads only: no origin call, no grant consumed, no need created, no audit row. Listing grants
 * may mark an already-expired grant `expired`, which is idempotent bookkeeping, not a side effect
 * of the dry run itself.
 */
async function dryRun(deps: ConnectorCallDeps, target: ConnectorTarget, environment: VaultEnvName): Promise<DryRunReport> {
  const { kernel, principal } = deps;
  const items = await kernel.listItems(principal.orgId, environment);
  let reason: string | undefined;
  let item = undefined as (typeof items)[number] | undefined;
  if (target.itemName) {
    let wanted: string;
    try {
      wanted = normalizeSecretName(target.itemName);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : "Invalid name");
    }
    item = items.find((i) => i.name === wanted);
    if (!item) reason = "need_item";
    else if (target.host && !item.allowedHosts.includes(target.host)) reason = "host_mismatch";
  } else if (target.host) {
    const host = target.host;
    const matches = items.filter((i) => i.allowedHosts.includes(host));
    if (matches.length === 0) reason = "need_item";
    else if (matches.length > 1) reason = "ambiguous";
    else item = matches[0];
  }
  const host = target.host ?? item?.allowedHosts[0] ?? "";
  const provider = host ? providerForHost(host) : undefined;
  const injectMode = item ? injectModeOf(item.inject) : null;
  if (item && !injectMode) reason ??= "inject_unsupported";
  const grantStatus = item ? await grantStatusFor(deps, item.id, item.name, environment) : "none";
  if (item && !reason && grantStatus !== "standing" && grantStatus !== "active") {
    reason = grantStatus === "pending" ? "grant_pending" : "grant_required";
  }
  return {
    dry_run: true,
    item_name: item?.name ?? target.itemName ?? null,
    host,
    method: target.method,
    path: target.path,
    would_send: item !== undefined && reason === undefined,
    reason: reason ?? "ok",
    grant_status: grantStatus,
    inject_mode: injectMode ?? item?.inject ?? null,
    provider: provider?.id ?? null,
  };
}

async function grantStatusFor(
  deps: ConnectorCallDeps,
  itemId: string,
  itemName: string,
  environment: VaultEnvName,
): Promise<DryRunReport["grant_status"]> {
  const { kernel, principal } = deps;
  const stored = await kernel.findStoredItem(principal.orgId, environment, itemName);
  if (stored) {
    const itemPolicy = await kernel.store.findItemPolicy(principal.orgId, principal.clientId, stored.id);
    const folderPolicy = itemPolicy
      ? undefined
      : await kernel.store.findFolderPolicy(principal.orgId, principal.clientId, stored.folderId, stored.environmentId);
    if (itemPolicy || folderPolicy) return "standing";
  }
  const grants = (await kernel.listClientGrants(principal.orgId, principal.clientId)).filter((g) => g.itemId === itemId);
  if (grants.some((g) => g.status === "active")) return "active";
  if (grants.some((g) => g.status === "pending")) return "pending";
  return "none";
}
