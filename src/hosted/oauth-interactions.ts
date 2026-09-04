import type { IncomingMessage, ServerResponse } from "node:http";
import type Provider from "oidc-provider";
import type { InteractionDetails, InteractionResult } from "oidc-provider";
import type { OperatorPrincipal, Principal } from "./auth.ts";
import { requireOperator } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { kernelForProvider, redirectHosts } from "./oauth-as.ts";
import { orgScope } from "./oauth-clients.ts";
import { consentExpiredHtml, consentHtml, type ConsentView } from "./oauth-pages.ts";
import { sendHtml } from "./http-auth-routes.ts";
import { needsTotpVerify } from "./identity.ts";
import { bindSecurityHeaders } from "./security-headers.ts";

/** Scopes this AS issues; mirrors `scopes` in createOauthProvider. */
const GRANTABLE_SCOPES: ReadonlySet<string> = new Set(["openid", "mcp"]);

function clientIdOf(details: InteractionDetails): string {
  const raw = details.params.client_id;
  return typeof raw === "string" ? raw : "";
}

async function consentView(
  provider: Provider,
  op: OperatorPrincipal,
  clientId: string,
): Promise<{ name: string; view: ConsentView }> {
  const client = clientId ? await provider.Client.find(clientId) : undefined;
  const name = (client?.clientName?.trim() || clientId || "MCP client").slice(0, 80);
  const view: ConsentView = { hosts: redirectHosts(client?.redirectUris) };
  const kernel = kernelForProvider(provider);
  if (kernel && clientId) {
    const existing = await kernel.store.findClientByOrgAndOauthId(op.orgId, clientId);
    view.firstTime = !existing;
    const user = await kernel.store.getUser(op.userId);
    if (user?.email) view.email = user.email;
  }
  return { name, view };
}

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
    res.writeHead(302, { location: needsTotpVerify(principal) ? "/verify-totp" : "/enroll-totp" });
    res.end();
    return true;
  }
  let details: InteractionDetails;
  try {
    details = await provider.interactionDetails(req, res);
  } catch {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...htmlHeaders });
    res.end(consentExpiredHtml());
    return true;
  }
  const { name, view } = await consentView(provider, principal, clientIdOf(details));
  sendHtml(res, consentHtml(name, details.uid, view), htmlHeaders);
  return true;
}

/** The consent page's script asks for JSON; a plain form submit or a Node client does not. */
function wantsJson(req: IncomingMessage): boolean {
  const accept = typeof req.headers.accept === "string" ? req.headers.accept : "";
  return accept.split(",").some((part) => (part.split(";")[0] ?? "").trim().toLowerCase() === "application/json");
}

/**
 * Hand the decision to the OAuth provider and send the browser on to the resume URL.
 * A `fetch` cannot read the Location of a 303 (browsers hide redirects from scripts), so a
 * JSON caller gets `200 { location }` and navigates itself; everyone else gets the 303.
 */
async function finishInteraction(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
  result: InteractionResult,
): Promise<void> {
  if (!wantsJson(req)) {
    await provider.interactionFinished(req, res, result);
    return;
  }
  const location = await provider.interactionResult(req, res, result);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ location }));
}

/**
 * Only the literal decision "allow" grants. Anything else (deny, missing, a typo, a
 * replayed form with a different value) is access_denied.
 */
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
  if (body.decision !== "allow") {
    await finishInteraction(provider, req, res, { error: "access_denied", error_description: "denied" });
    return;
  }
  const details = await provider.interactionDetails(req, res);
  if (typeof body.uid === "string" && body.uid && body.uid !== details.uid) {
    throw new HttpError(400, "Consent form does not match the pending request");
  }
  const clientId = clientIdOf(details);
  if (!clientId) throw new HttpError(400, "Pending request has no client");
  const grant = new provider.Grant({ accountId: op.userId, clientId });
  // `mcp` is declared as an OP scope (so it is advertised) and as the MCP resource scope;
  // the interaction policy checks both, so grant whichever of the two were requested.
  const requested = typeof details.params.scope === "string" ? details.params.scope.split(/\s+/) : [];
  const granted = requested.filter((s) => GRANTABLE_SCOPES.has(s));
  grant.addOIDCScope((granted.length > 0 ? granted : ["openid"]).join(" "));
  // The org this operator session acts in is bound into the Grant. Every token issued
  // under it carries that org, and /mcp checks the account is still a member; the org is
  // never inferred from the account's first membership at verification time.
  grant.addResourceScope(audience, `mcp ${orgScope(op.orgId)}`);
  const grantId = await grant.save();
  // remember: false keeps the OP login transient; Botpasses owns the durable session.
  await finishInteraction(provider, req, res, {
    login: { accountId: op.userId, remember: false },
    consent: { grantId },
  });
}
