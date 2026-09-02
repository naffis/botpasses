import type { VaultEnvName } from "../hosted-types.ts";
import { executeConnector, type ConnectorFetch, type ConnectorItem } from "./connector.ts";
import { HttpError, isHttpError, isNeedItemError, type NeedItemPayload } from "./errors.ts";
import type { HostedKernel } from "./kernel.ts";
import type { ModelPrincipal } from "./auth.ts";
import {
  cachedMint,
  emptyOriginHint,
  isSpotifyTokenPath,
  isSpotifyUserPath,
  itemWithAccessToken,
  mintSpotifyAccessToken,
  readMintedAccessToken,
  redactConnectorOauthBody,
  refreshItemName,
  resolveSpotifyClientId,
  shouldMintClientCredentials,
  shouldUseBasicOnTokenHost,
  storeMint,
  userContextHint,
} from "./spotify.ts";

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
};

type GrantHalt = {
  grant_id: string;
  status: string;
  approval_code?: string;
  notify_failed: boolean;
  item_name: string;
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
      throw new HttpError(400, "host must be a hostname such as api.spotify.com");
    }
  }
  if (host) host = host.toLowerCase();
  if (!itemName && !host) {
    throw new HttpError(
      400,
      "http.request requires item_name or host, plus method and path. Example: host=api.spotify.com method=GET path=/v1/me",
    );
  }
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new HttpError(400, "path must start with /");
  }
  return { itemName, host, method, path, taskDescription, clientId, contentType };
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

function originPayload(
  origin: { status: number; body: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const hint = extra.hint ?? (origin.body.trim() ? undefined : emptyOriginHint(origin.status));
  return {
    status: origin.status,
    body: origin.body,
    ...extra,
    ...(hint ? { hint } : {}),
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

export async function runHttpRequest(
  deps: ConnectorCallDeps,
  args: Record<string, unknown>,
  environment: VaultEnvName,
): Promise<unknown> {
  const target = connectorTargetFromArgs(args);
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
    throw new HttpError(400, "http.request requires item_name or host");
  }
  const prepared = await prepareOrGrant(deps, {
    itemName,
    environment,
    taskDescription: target.taskDescription,
  });
  if (!isPreparedConnector(prepared)) return withRetry(prepared, target, itemName);
  try {
    const result = await dispatchConnector(deps, prepared, target, args, environment);
    if (typeof result === "object" && result && "status" in result) {
      const status = (result as { status: unknown }).status;
      if (typeof status === "number") {
        await releaseGrantOnFailure(deps.kernel, prepared, status);
      }
    }
    return withRetry(result, target, itemName);
  } catch (err) {
    await releaseGrantOnFailure(deps.kernel, prepared);
    throw err;
  }
}

async function dispatchConnector(
  deps: ConnectorCallDeps,
  item: ConnectorItem,
  target: ConnectorTarget,
  args: Record<string, unknown>,
  environment: VaultEnvName,
): Promise<unknown> {
  const host = target.host ?? item.allowedHosts[0] ?? "";
  const clientId = resolveSpotifyClientId(item, target.clientId);
  const contentType =
    target.contentType ??
    (isSpotifyTokenPath(host, target.path)
      ? "application/x-www-form-urlencoded"
      : args.body !== undefined
        ? "application/json"
        : undefined);

  if (isSpotifyTokenPath(host, target.path)) {
    const tokenItem = shouldUseBasicOnTokenHost(host, item)
      ? { ...item, inject: "basic", username: clientId ?? item.username }
      : item;
    const body =
      args.body === undefined || args.body === null
        ? { grant_type: "client_credentials" }
        : args.body;
    const origin = await executeConnector(
      tokenItem,
      {
        method: target.method,
        path: target.path,
        host,
        body,
        contentType: contentType ?? "application/x-www-form-urlencoded",
      },
      { fetchImpl: deps.fetchImpl, resolveAddresses: deps.resolveAddresses, redact: false },
    );
    if (origin.status >= 200 && origin.status < 300 && clientId) {
      try {
        const minted = readMintedAccessToken(origin.body);
        storeMint(deps.principal.orgId, item.itemId ?? item.name, clientId, "client_credentials", minted);
        return originPayload(
          {
            status: origin.status,
            body: redactConnectorOauthBody(origin.body, item, [minted.accessToken]),
          },
          { minted: true, token_last4: minted.last4 },
        );
      } catch {
        return originPayload({
          status: origin.status,
          body: redactConnectorOauthBody(origin.body, item),
        });
      }
    }
    return originPayload({
      status: origin.status,
      body: redactConnectorOauthBody(origin.body, item),
    });
  }

  if (isSpotifyUserPath(host, target.path)) {
    const user = await tryUserSpotify(deps, item, target, environment, host);
    if (user) return user;
  }

  if (shouldMintClientCredentials({ host, path: target.path, item, clientId })) {
    if (!clientId) {
      return {
        status: 400,
        error: "client_id_required",
        hint:
          "This item is a Client Secret, not a user access token. Pass client_id or store the Spotify Client ID as the item username, then retry. Token mint uses HTTP Basic + form body.",
      };
    }
    const minted = await ensureAppToken(deps, item, clientId);
    if ("status" in minted) return minted;
    const origin = await executeConnector(
      itemWithAccessToken(item, minted.accessToken),
      { method: target.method, path: target.path, host, body: args.body, contentType },
      { fetchImpl: deps.fetchImpl, resolveAddresses: deps.resolveAddresses },
    );
    const extra: Record<string, unknown> = { minted: true, token_last4: minted.last4 };
    if (origin.status === 401 && isSpotifyUserPath(host, target.path)) {
      extra.hint = userContextHint(target.path);
    }
    return originPayload(origin, extra);
  }

  const callItem = shouldUseBasicOnTokenHost(host, item)
    ? { ...item, inject: "basic", username: clientId ?? item.username }
    : item;
  const origin = await executeConnector(
    callItem,
    { method: target.method, path: target.path, host, body: args.body, contentType },
    { fetchImpl: deps.fetchImpl, resolveAddresses: deps.resolveAddresses },
  );
  if (origin.status === 401 && isSpotifyUserPath(host, target.path)) {
    return originPayload(origin, { hint: userContextHint(target.path) });
  }
  return originPayload(origin);
}

async function ensureAppToken(
  deps: ConnectorCallDeps,
  item: ConnectorItem,
  clientId: string,
): Promise<{ accessToken: string; last4: string } | { status: number; body: string; hint?: string }> {
  const cached = cachedMint(
    deps.principal.orgId,
    item.itemId ?? item.name,
    clientId,
    "client_credentials",
  );
  if (cached) return { accessToken: cached.accessToken, last4: cached.last4 };
  const { minted, origin } = await mintSpotifyAccessToken({
    item,
    clientId,
    grantType: "client_credentials",
    fetchImpl: deps.fetchImpl,
    resolveAddresses: deps.resolveAddresses,
  });
  if (origin.status < 200 || origin.status >= 300 || !minted.accessToken) {
    return originPayload(origin, {
      hint:
        "Spotify token mint failed. Retry uses the same approval. Token endpoint needs HTTP Basic (client_id:client_secret) and application/x-www-form-urlencoded.",
    }) as { status: number; body: string; hint?: string };
  }
  storeMint(deps.principal.orgId, item.itemId ?? item.name, clientId, "client_credentials", minted);
  return { accessToken: minted.accessToken, last4: minted.last4 };
}

async function tryUserSpotify(
  deps: ConnectorCallDeps,
  item: ConnectorItem,
  target: ConnectorTarget,
  environment: VaultEnvName,
  host: string,
): Promise<unknown | undefined> {
  const refreshName = refreshItemName(item.name);
  const stored = await deps.kernel.findStoredItem(deps.principal.orgId, environment, refreshName);
  if (!stored) return undefined;
  try {
    const refreshItem = await deps.kernel.prepareConnector({
      orgId: deps.principal.orgId,
      clientId: deps.principal.clientId,
      itemName: refreshName,
      environment,
    });
    const clientId = resolveSpotifyClientId(refreshItem, target.clientId) ?? resolveSpotifyClientId(item, target.clientId);
    if (!clientId) return undefined;
    let cached = cachedMint(deps.principal.orgId, refreshItem.itemId ?? refreshName, clientId, "refresh");
    if (!cached) {
      const { minted, origin } = await mintSpotifyAccessToken({
        item: refreshItem,
        clientId,
        grantType: "refresh",
        refreshToken: refreshItem.secret,
        fetchImpl: deps.fetchImpl,
        resolveAddresses: deps.resolveAddresses,
      });
      if (origin.status < 200 || origin.status >= 300 || !minted.accessToken) {
        await deps.kernel.reactivatePromptGrant(refreshItem.grantId);
        return originPayload(origin, { hint: userContextHint(target.path) });
      }
      storeMint(deps.principal.orgId, refreshItem.itemId ?? refreshName, clientId, "refresh", minted);
      cached = minted;
    }
    const origin = await executeConnector(
      itemWithAccessToken(item, cached.accessToken),
      { method: target.method, path: target.path, host, body: undefined },
      { fetchImpl: deps.fetchImpl, resolveAddresses: deps.resolveAddresses },
    );
    if (origin.status < 200 || origin.status >= 300) {
      await deps.kernel.reactivatePromptGrant(refreshItem.grantId);
    }
    return originPayload(origin, { user_token: true, token_last4: cached.last4 });
  } catch (err) {
    if (isNeedItemError(err) || (isHttpError(err) && err.message === "inject_denied")) {
      return undefined;
    }
    throw err;
  }
}

async function prepareOrGrant(
  deps: ConnectorCallDeps,
  input: { itemName: string; environment: VaultEnvName; taskDescription?: string },
): Promise<ConnectorItem | NeedItemPayload | GrantHalt> {
  const { kernel, principal } = deps;
  try {
    return await kernel.prepareConnector({
      orgId: principal.orgId,
      clientId: principal.clientId,
      itemName: input.itemName,
      environment: input.environment,
    });
  } catch (err) {
    if (isNeedItemError(err)) return err.payload;
    if (isHttpError(err) && err.status === 403 && err.message === "inject_denied") {
      const result = await kernel.requestGrant({
        orgId: principal.orgId,
        clientId: principal.clientId,
        itemName: input.itemName,
        environment: input.environment,
        taskDescription: input.taskDescription,
      });
      if (result.grant.status === "active") {
        return kernel.prepareConnector({
          orgId: principal.orgId,
          clientId: principal.clientId,
          itemName: input.itemName,
          environment: input.environment,
        });
      }
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
