/** Grant routes: request, approve, revoke, approve-by-code, magic link, inbox, audit. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertSafePublicObject } from "../redact.ts";
import { agentPassEnabled } from "./agentpass.ts";
import { requireModelOrOperator, requireOperator, type Principal } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { asEnv, asPolicy, json, optional, readJson } from "./http-util.ts";
import type { HostedKernel } from "./kernel.ts";

export async function handleGrantRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  path: string,
  principal: Principal | undefined,
  kernel: HostedKernel,
): Promise<boolean> {
  if (method === "POST" && path === "/api/grants/request") {
    const actor = requireModelOrOperator(principal);
    const orgId = actor.orgId;
    if (!(await kernel.limiter.allow(orgId))) throw new HttpError(429, "request_grant rate limit");
    const body = await readJson(req);
    const clientId =
      actor.channel === "model" ? actor.clientId : String(body.client_id ?? body.clientId ?? "");
    const result = await kernel.requestGrant({
      orgId,
      clientId,
      itemName: String(body.item_name ?? body.itemName ?? ""),
      environment: asEnv(body.environment),
      taskId: optional(body.task_id ?? body.taskId),
      taskDescription: optional(body.task_description ?? body.taskDescription),
      operatorEmail: optional(body.operator_email ?? body.operatorEmail),
    });
    json(res, 200, {
      grant: result.grant,
      approval_code: result.code,
      notify_failed: result.notifyFailed ?? false,
    });
    return true;
  }
  if (method === "GET" && path === "/api/inbox") {
    const op = requireOperator(principal);
    const grants = await kernel.inboxGrantCards(op.orgId);
    const needs = await kernel.listInboxNeeds(op.orgId);
    const agentpass = agentPassEnabled()
      ? (await kernel.store.listAgentPasses(op.orgId)).filter((p) => p.status === "pending")
      : [];
    json(res, 200, { grants, needs, agentpass });
    return true;
  }
  if (method === "GET" && path === "/api/audit") {
    const op = requireOperator(principal);
    const clientId = optional(url.searchParams.get("client_id"));
    const itemName = optional(url.searchParams.get("item_name"));
    const filter = clientId || itemName ? { clientId, itemName } : undefined;
    const audit = await kernel.store.listAudit(op.orgId, 200, filter);
    assertSafePublicObject("listAudit", audit);
    json(res, 200, { audit });
    return true;
  }
  const approve = /^\/api\/grants\/([^/]+)\/approve$/.exec(path);
  if (method === "POST" && approve) {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const grant = await kernel.approveGrant({
      orgId: op.orgId,
      grantId: decodeURIComponent(approve[1] ?? ""),
      policy: asPolicy(body.policy),
      confirmName: optional(body.confirm_name ?? body.confirmName),
      role: op.role,
      actor: op.userId,
    });
    json(res, 200, { grant });
    return true;
  }
  const revoke = /^\/api\/grants\/([^/]+)\/revoke$/.exec(path);
  if (method === "POST" && revoke) {
    const op = requireOperator(principal);
    const grant = await kernel.revokeGrant(
      op.orgId,
      op.userId,
      decodeURIComponent(revoke[1] ?? ""),
    );
    json(res, 200, { grant });
    return true;
  }
  if (method === "POST" && path === "/api/grants/approve-by-code") {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const grant = await kernel.approveByCode(
      op.orgId,
      op.userId,
      op.role,
      String(body.code ?? ""),
    );
    json(res, 200, { grant });
    return true;
  }
  if ((method === "GET" || method === "POST") && path === "/approve") {
    const op = requireOperator(principal);
    const token =
      url.searchParams.get("token") ?? String((await readJson(req)).token ?? "");
    const grant = await kernel.approveMagic(op.orgId, op.userId, op.role, token);
    json(res, 200, { grant });
    return true;
  }
  return false;
}
