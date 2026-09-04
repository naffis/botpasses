/** Grant routes: request, approve, revoke, approve-by-code, magic link, inbox, audit. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertSafePublicObject } from "../redact.ts";
import { agentPassEnabled } from "./agentpass.ts";
import { requireModelOrOperator, requireOperator, type Principal } from "./auth.ts";
import { approveConfirmHtml, approveDoneHtml, approveErrorHtml } from "./approve-page.ts";
import { isHttpError } from "./errors.ts";
import { asEnv, asPolicy, json, optional, readJson, readJsonOrForm, sendHtml } from "./http-util.ts";
import type { HostedKernel } from "./kernel.ts";

export type GrantRouteOpts = {
  kernel: HostedKernel;
  /** Headers for operator HTML (CSP with nonce). */
  htmlHeaders: () => Record<string, string>;
};

export async function handleGrantRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  path: string,
  principal: Principal | undefined,
  opts: GrantRouteOpts,
): Promise<boolean> {
  const { kernel } = opts;
  if (method === "POST" && path === "/api/grants/request") {
    const actor = requireModelOrOperator(principal);
    const orgId = actor.orgId;
    const body = await readJson(req);
    const clientId =
      actor.channel === "model" ? actor.clientId : String(body.client_id ?? body.clientId ?? "");
    // S3: a model must not pick who gets the approval email; the kernel notifies org members.
    // An operator may address one member of their own org.
    const requested =
      actor.channel === "operator" ? optional(body.operator_email ?? body.operatorEmail) : undefined;
    const operatorEmail = requested ? await kernel.assertMemberEmail(orgId, requested) : undefined;
    const result = await kernel.requestGrant({
      orgId,
      clientId,
      itemName: String(body.item_name ?? body.itemName ?? ""),
      environment: asEnv(body.environment),
      taskId: optional(body.task_id ?? body.taskId),
      taskDescription: optional(body.task_description ?? body.taskDescription),
      operatorEmail,
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
  if (method === "GET" && path === "/approve") {
    if (!principal) {
      res.writeHead(302, { location: "/sign-in" });
      res.end();
      return true;
    }
    const op = requireOperator(principal);
    const token = url.searchParams.get("token") ?? "";
    try {
      const preview = await kernel.previewMagic(op.orgId, token);
      sendHtml(
        res,
        200,
        approveConfirmHtml({
          token,
          clientName: preview.client_name,
          itemName: preview.item_name,
          last4: preview.item_last4,
          policy: preview.policy,
          taskDescription: preview.task_description,
        }),
        opts.htmlHeaders(),
      );
    } catch (err) {
      if (!isHttpError(err)) throw err;
      sendHtml(res, err.status, approveErrorHtml(err.message), opts.htmlHeaders());
    }
    return true;
  }
  if (method === "POST" && path === "/approve") {
    const op = requireOperator(principal);
    const body = await readJsonOrForm(req);
    const token = String(body.token ?? "");
    const wantsHtml = (req.headers.accept ?? "").includes("text/html");
    try {
      const grant = await kernel.approveMagic(op.orgId, op.userId, op.role, token);
      if (wantsHtml) {
        const item = grant.itemId ? await kernel.store.getItem(grant.itemId) : undefined;
        sendHtml(res, 200, approveDoneHtml(item?.name ?? "The request"), opts.htmlHeaders());
        return true;
      }
      json(res, 200, { grant });
    } catch (err) {
      if (!wantsHtml || !isHttpError(err)) throw err;
      sendHtml(res, err.status, approveErrorHtml(err.message), opts.htmlHeaders());
    }
    return true;
  }
  return false;
}
