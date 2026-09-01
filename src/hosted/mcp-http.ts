import type { VaultEnvName } from "../hosted-types.ts";
import { executeConnector, type ConnectorFetch, type ConnectorItem } from "./connector.ts";
import { HttpError, isHttpError, isNeedItemError, type NeedItemPayload } from "./errors.ts";
import type { HostedKernel } from "./kernel.ts";
import type { ModelPrincipal } from "./auth.ts";

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
  return { itemName, host, method, path, taskDescription };
}

export function retryFields(target: ConnectorTarget, itemName?: string): Record<string, string> {
  const retry: Record<string, string> = { method: target.method, path: target.path };
  if (target.host) retry.host = target.host;
  const name = itemName ?? target.itemName;
  if (name) retry.item_name = name;
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
  const origin = await executeConnector(
    prepared,
    { method: target.method, path: target.path, body: args.body },
    { fetchImpl: deps.fetchImpl, resolveAddresses: deps.resolveAddresses },
  );
  return { status: origin.status, body: origin.body };
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
