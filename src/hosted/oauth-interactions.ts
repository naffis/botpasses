import type { IncomingMessage, ServerResponse } from "node:http";
import type Provider from "oidc-provider";
import type { Principal } from "./auth.ts";
import { requireOperator } from "./auth.ts";
import { consentHtml } from "./auth-pages.ts";
import { sendHtml } from "./http-auth-routes.ts";
import { bindSecurityHeaders } from "./security-headers.ts";

type InteractionDetails = {
  uid: string;
  params?: Record<string, unknown>;
};

export async function handleConsentGet(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal | undefined,
  htmlHeaders: Record<string, string>,
): Promise<boolean> {
  bindSecurityHeaders(res);
  if (!principal || principal.channel !== "operator") {
    res.writeHead(302, { location: "/sign-in" });
    res.end();
    return true;
  }
  if (principal.ready === false) {
    res.writeHead(302, { location: "/enroll-totp" });
    res.end();
    return true;
  }
  let name = "MCP client";
  let uid = "";
  try {
    const details = (await provider.interactionDetails(req, res)) as InteractionDetails;
    uid = details.uid;
    const raw = details.params?.client_name ?? details.params?.client_id;
    if (typeof raw === "string" && raw) name = raw.slice(0, 80);
  } catch {
    uid = "";
  }
  sendHtml(res, consentHtml(name, uid), htmlHeaders);
  return true;
}

export async function handleConsentPost(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal | undefined,
  body: Record<string, unknown>,
  audience: string,
): Promise<void> {
  bindSecurityHeaders(res);
  const op = requireOperator(principal);
  const decision = String(body.decision ?? "");
  if (decision === "deny") {
    await provider.interactionFinished(req, res, { error: "access_denied", error_description: "denied" });
    return;
  }
  const details = (await provider.interactionDetails(req, res)) as InteractionDetails;
  const clientId = typeof details.params?.client_id === "string" ? details.params.client_id : "";
  const grant = new provider.Grant({ accountId: op.userId, clientId });
  grant.addOIDCScope("openid");
  grant.addResourceScope(audience, "mcp");
  const grantId = await grant.save();
  await provider.interactionFinished(req, res, {
    login: { accountId: op.userId },
    consent: { grantId },
  });
}

