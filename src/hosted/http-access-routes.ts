import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostedKernel } from "./kernel.ts";
import { requireOperator, type Principal } from "./auth.ts";
import { HttpError } from "./errors.ts";

export async function handleAccessApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  principal: Principal | undefined,
  kernel: HostedKernel,
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>,
  json: (res: ServerResponse, status: number, body: unknown) => void,
): Promise<boolean> {
  if (method === "GET" && path === "/api/access") {
    const op = requireOperator(principal);
    const snap = await kernel.listAccess(op.orgId, op.sessionHash);
    json(res, 200, {
      operators: snap.operators,
      clients: snap.clients,
      grants: snap.grants,
      sessions: snap.sessions,
    });
    return true;
  }
  if (method === "GET" && path === "/api/access/events") {
    const op = requireOperator(principal);
    const events = await kernel.store.listAccessEvents(op.orgId, 200);
    json(res, 200, {
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        client_id: e.clientId,
        issued_at: e.issuedAt,
        expires_at: e.expiresAt,
        revoked_at: e.revokedAt,
      })),
    });
    return true;
  }
  const revClient = /^\/api\/clients\/([^/]+)\/revoke$/.exec(path);
  if (method === "POST" && revClient) {
    const op = requireOperator(principal);
    await kernel.revokeClient(op.orgId, op.userId, decodeURIComponent(revClient[1] ?? ""));
    json(res, 200, { ok: true });
    return true;
  }
  const revSess = /^\/api\/sessions\/([^/]+)\/revoke$/.exec(path);
  if (method === "POST" && revSess) {
    const op = requireOperator(principal);
    if (!op.sessionHash) throw new HttpError(400, "cannot_revoke_current");
    await kernel.revokeSession(
      op.orgId,
      { userId: op.userId, role: op.role, sessionHash: op.sessionHash },
      decodeURIComponent(revSess[1] ?? ""),
    );
    json(res, 200, { ok: true });
    return true;
  }
  if (method === "POST" && path === "/api/sessions/revoke-others") {
    const op = requireOperator(principal);
    if (!op.sessionHash) throw new HttpError(400, "cannot_revoke_current");
    await kernel.store.deleteOtherSessions(op.userId, op.sessionHash);
    json(res, 200, { ok: true });
    return true;
  }
  void req;
  void readJson;
  return false;
}
