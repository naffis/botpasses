/** Operator client routes: issue, rotate machine bearers. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireOperator, type Principal } from "./auth.ts";
import { asEnv, json, readJson } from "./http-util.ts";
import type { HostedKernel } from "./kernel.ts";

export async function handleClientRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  principal: Principal | undefined,
  kernel: HostedKernel,
  publicUrl: string,
): Promise<boolean> {
  const rotateClient = /^\/api\/clients\/([^/]+)\/rotate$/.exec(path);
  if (method === "POST" && rotateClient) {
    const op = requireOperator(principal);
    const out = await kernel.rotateClient(
      op.orgId,
      op.userId,
      decodeURIComponent(rotateClient[1] ?? ""),
    );
    json(res, 200, out);
    return true;
  }
  if (method === "POST" && path === "/api/clients/trusted") {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const created = await kernel.createTrustedClient({
      orgId: op.orgId,
      name: String(body.name ?? "trusted"),
      environment: asEnv(body.environment),
    });
    json(res, 200, { client: { id: created.client.id, name: created.client.name }, token: created.plaintext });
    return true;
  }
  if (method === "POST" && path === "/api/clients/model") {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const created = await kernel.createModelClient({
      orgId: op.orgId,
      name: String(body.name ?? "grok"),
      environment: asEnv(body.environment),
      issueBearer: true,
    });
    json(res, 200, {
      client: { id: created.client.id, name: created.client.name, kind: created.client.kind },
      token: created.plaintext,
      mcp_url: `${publicUrl.replace(/\/$/, "")}/mcp`,
    });
    return true;
  }
  return false;
}
