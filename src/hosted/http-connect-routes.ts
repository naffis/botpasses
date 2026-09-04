/**
 * `GET /integrations/:provider/callback`: the provider sends the operator's browser back here
 * with `code` and `state`. Runs before the JSON API (no CSRF header on a top-level navigation);
 * the sealed state is the forgery defence. `spotify` is one value of `:provider`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "./auth.ts";
import type { ConnectorFetch } from "./connector.ts";
import type { HostedKernel } from "./kernel.ts";
import { connectErrorReason, type ConnectErrorReason } from "./kernel-connect.ts";

const CONNECT_CALLBACK_RE = /^\/integrations\/([a-z0-9_-]+)\/callback$/;

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
  const match = CONNECT_CALLBACK_RE.exec(path);
  if (method !== "GET" || !match) return false;
  const providerId = match[1] ?? "";
  if (!principal || principal.channel !== "operator" || principal.ready === false) {
    redirect(res, "/sign-in");
    return true;
  }
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (url.searchParams.get("error")) {
    // The provider said no (the operator cancelled, or the app is misconfigured there).
    redirect(res, connectErrorLocation(providerId, "provider_denied"));
    return true;
  }
  if (!code || !state) {
    redirect(res, "/console#vault");
    return true;
  }
  try {
    await kernel.finishProviderUserOauth({
      providerId,
      orgId: principal.orgId,
      userId: principal.userId,
      state,
      code,
      fetchImpl,
    });
    redirect(res, `/console#vault?connected=${encodeURIComponent(providerId)}`);
  } catch (err) {
    redirect(res, connectErrorLocation(providerId, connectErrorReason(err)));
  }
  return true;
}
