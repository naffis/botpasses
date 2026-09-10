/**
 * `GET /connect/callback` (and the expand-only `/integrations/:provider/callback` alias): the
 * provider sends the operator's browser back here with `code` and `state`. Runs before the JSON
 * API (no CSRF header on a top-level navigation); the sealed state is the forgery defence.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "./auth.ts";
import type { ConnectorFetch } from "./connector.ts";
import type { HostedKernel } from "./kernel.ts";
import { connectErrorReason, type ConnectErrorReason } from "./kernel-connect.ts";
import { HOSTED_CONNECT_CALLBACK_PATH } from "./providers/connect-redirect.ts";

const LEGACY_CALLBACK_RE = /^\/integrations\/([a-z0-9_-]+)\/callback$/;

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

/** `/console#vault?connect_error=<provider>&reason=<code>`: the console names the fix per code. */
function connectErrorLocation(providerId: string, reason: ConnectErrorReason): string {
  return `/console#vault?connect_error=${encodeURIComponent(providerId)}&reason=${reason}`;
}

export async function handleConnectCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  path: string,
  principal: Principal | undefined,
  kernel: HostedKernel,
  fetchImpl: ConnectorFetch | undefined,
): Promise<boolean> {
  const legacy = LEGACY_CALLBACK_RE.exec(path);
  const canonical = path === HOSTED_CONNECT_CALLBACK_PATH;
  if (method !== "GET" || (!legacy && !canonical)) return false;
  const pathProvider = legacy?.[1];
  if (!principal || principal.channel !== "operator" || principal.ready === false) {
    redirect(res, "/sign-in");
    return true;
  }
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const flashProvider = pathProvider || kernel.providerIdFromConnectState(state) || "account";
  if (url.searchParams.get("error")) {
    // The provider said no (the operator cancelled, or the app is misconfigured there).
    redirect(res, connectErrorLocation(flashProvider, "provider_denied"));
    return true;
  }
  if (!code || !state) {
    redirect(res, "/console#vault");
    return true;
  }
  try {
    const done = await kernel.finishProviderUserOauth({
      ...(pathProvider ? { providerId: pathProvider } : {}),
      orgId: principal.orgId,
      userId: principal.userId,
      state,
      code,
      fetchImpl,
    });
    // `agent` tells the console the named agent can retry its call now (it holds the policy).
    const agent = done.agent_client_id ? `&agent=${encodeURIComponent(done.agent_client_id)}` : "";
    redirect(res, `/console#vault?connected=${encodeURIComponent(done.provider)}${agent}`);
  } catch (err) {
    redirect(res, connectErrorLocation(flashProvider, connectErrorReason(err)));
  }
  return true;
}
