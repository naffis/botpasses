/** Operator vault item routes: /api/items, /api/folders, /api/need-items, provider user connect. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireOperator, type Principal } from "./auth.ts";
import { asEnv, asHosts, asKind, json, optional, readJson } from "./http-util.ts";
import type { HostedKernel } from "./kernel.ts";
import { defaultInjectForKind } from "./store-form-fields.ts";
import { parseInjectMode } from "./providers/inject.ts";

/** `POST /api/integrations/:provider/start`; `spotify` is one value of `:provider`. */
const CONNECT_START_RE = /^\/api\/integrations\/([a-z0-9_-]+)\/start$/;

export async function handleItemRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  path: string,
  principal: Principal | undefined,
  kernel: HostedKernel,
): Promise<boolean> {
  if (method === "GET" && path === "/api/items") {
    const op = requireOperator(principal);
    const raw = url.searchParams.get("environment");
    if (raw === null || raw === "") {
      json(res, 200, { items: await kernel.listItemsOnPlane(op.orgId) });
      return true;
    }
    json(res, 200, { items: await kernel.listItems(op.orgId, asEnv(raw)) });
    return true;
  }
  if (method === "POST" && path === "/api/items") {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const kind = asKind(body.kind);
    const item = await kernel.createItem({
      orgId: op.orgId,
      actor: op.userId,
      environment: asEnv(body.environment),
      kind,
      name: String(body.name ?? ""),
      value: String(body.value ?? ""),
      username: optional(body.username),
      allowedHosts: asHosts(body.allowed_hosts ?? body.allowedHosts),
      inject: parseInjectMode(String(body.inject ?? defaultInjectForKind(kind))),
      folderName: optional(body.folder_name ?? body.folderName),
    });
    json(res, 200, { item });
    return true;
  }
  const getNeedApi = /^\/api\/need-items\/([^/]+)$/.exec(path);
  if (method === "GET" && getNeedApi) {
    if (!principal || principal.channel !== "operator") {
      json(res, 404, { error: "Unknown need" });
      return true;
    }
    const op = requireOperator(principal);
    const needId = decodeURIComponent(getNeedApi[1] ?? "");
    const row = await kernel.store.getNeed(needId);
    if (!row) {
      json(res, 404, { error: "Unknown need" });
      return true;
    }
    // Another org's need reads as unknown: a 403 would confirm the id exists.
    if (row.orgId !== op.orgId) {
      json(res, 404, { error: "Unknown need" });
      return true;
    }
    const found = await kernel.getNeed(needId);
    if (!found) {
      json(res, 404, { error: "Unknown need" });
      return true;
    }
    json(res, 200, {
      id: found.need.id,
      kind: found.need.kind,
      provider: found.need.provider,
      client_name: found.need.client_name,
      suggested_name: found.need.suggested_name,
      host: found.need.host,
      task_description: found.need.task_description,
      status: found.need.status,
      recipe: found.need.recipe,
    });
    return true;
  }
  const fulfillNeed = /^\/api\/need-items\/([^/]+)\/fulfill$/.exec(path);
  if (method === "POST" && fulfillNeed) {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const result = await kernel.fulfillNeed({
      orgId: op.orgId,
      actor: op.userId,
      needId: decodeURIComponent(fulfillNeed[1] ?? ""),
      value: String(body.value ?? ""),
      name: optional(body.name),
      allowedHosts: asHosts(body.allowed_hosts ?? body.allowedHosts),
      inject: parseInjectMode(String(body.inject ?? defaultInjectForKind(body.kind === undefined ? "secret" : asKind(body.kind)))),
      kind: body.kind === undefined ? undefined : asKind(body.kind),
      username: optional(body.username),
      alwaysAllow: body.always_allow === true,
    });
    json(res, 200, { item: result.item, grant_status: result.grant_status });
    return true;
  }
  const itemUpdate = /^\/api\/items\/([^/]+)(?:\/meta)?$/.exec(path);
  if (method === "POST" && itemUpdate) {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const item = await kernel.updateItem({
      orgId: op.orgId,
      actor: op.userId,
      itemId: decodeURIComponent(itemUpdate[1] ?? ""),
      name: optional(body.name),
      kind: body.kind === undefined ? undefined : asKind(body.kind),
      environment: body.environment === undefined ? undefined : asEnv(body.environment),
      username: optional(body.username),
      inject: body.inject === undefined ? undefined : parseInjectMode(String(body.inject)),
      allowedHosts: body.allowed_hosts !== undefined || body.allowedHosts !== undefined
        ? asHosts(body.allowed_hosts ?? body.allowedHosts)
        : undefined,
      value: optional(body.value),
    });
    json(res, 200, { item });
    return true;
  }
  const connectStart = CONNECT_START_RE.exec(path);
  if (method === "POST" && connectStart) {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const started = await kernel.startProviderUserOauth({
      providerId: connectStart[1] ?? "",
      orgId: op.orgId,
      userId: op.userId,
      itemName: String(body.item_name ?? body.itemName ?? ""),
      environment: asEnv(body.environment),
      clientId: optional(body.client_id ?? body.clientId),
      redirectUri: optional(body.redirect_uri ?? body.redirectUri),
      agentClientId: optional(body.agent_client_id ?? body.agentClientId),
      needId: optional(body.need_id ?? body.needId),
    });
    json(res, 200, started);
    return true;
  }
  const denyNeed = /^\/api\/need-items\/([^/]+)\/deny$/.exec(path);
  if (method === "POST" && denyNeed) {
    const op = requireOperator(principal);
    await kernel.denyNeed({ orgId: op.orgId, actor: op.userId, needId: decodeURIComponent(denyNeed[1] ?? "") });
    json(res, 200, { ok: true });
    return true;
  }
  const rotate = /^\/api\/items\/([^/]+)\/rotate$/.exec(path);
  if (method === "POST" && rotate) {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const item = await kernel.rotateItem({
      orgId: op.orgId,
      actor: op.userId,
      itemId: decodeURIComponent(rotate[1] ?? ""),
      value: String(body.value ?? ""),
    });
    json(res, 200, { item });
    return true;
  }
  const del = /^\/api\/items\/([^/]+)$/.exec(path);
  if (method === "DELETE" && del) {
    const op = requireOperator(principal);
    await kernel.deleteItem(op.orgId, op.userId, decodeURIComponent(del[1] ?? ""));
    json(res, 200, { ok: true });
    return true;
  }
  if (method === "POST" && path === "/api/folders") {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const folder = await kernel.createFolder(
      op.orgId,
      asEnv(body.environment),
      String(body.name ?? ""),
    );
    json(res, 200, { folder });
    return true;
  }
  return false;
}
