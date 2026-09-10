/**
 * User connect (authorization_code, optionally PKCE) for any provider with an authorizeUrl.
 * State is sealed under the plane KEK so the callback cannot be forged or replayed across orgs.
 */
import { createHash, randomBytes } from "node:crypto";
import { decrypt, encrypt } from "../../crypto.ts";
import { HttpError } from "../errors.ts";
import type { Provider, ProviderId } from "./types.ts";
import {
  defaultConnectRedirect,
  isLoopbackPublicUrl,
  legacyProviderCallback,
  LOOPBACK_REDIRECT,
} from "./connect-redirect.ts";
import { isProviderId } from "./registry.ts";

export { HOSTED_CONNECT_CALLBACK_PATH, LOOPBACK_REDIRECT } from "./connect-redirect.ts";
const STATE_AAD = "provider-oauth-state";

export type ProviderOauthState = {
  providerId: ProviderId;
  orgId: string;
  userId: string;
  itemId: string;
  itemName: string;
  environment: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  exp: number;
  /** Botpasses model client that gets an `item_standing` policy on the refresh item after connect. */
  agentClientId?: string;
  /** The inbox connect need this flow answers, fulfilled by the callback. */
  needId?: string;
};

export function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The hosted user-connect callback. Provider is unused: one URI for every vendor app. */
export function hostedRedirect(_provider: Provider, publicUrl: string): string {
  return defaultConnectRedirect(publicUrl);
}

/**
 * The redirect URI the authorize request will carry. Only the hosted callback, its
 * per-provider alias, or the loopback dev callback are accepted so a stolen state cannot
 * send the code elsewhere.
 */
export function chooseRedirect(provider: Provider, publicUrl: string, requested?: string): string {
  const hosted = defaultConnectRedirect(publicUrl);
  const legacy = legacyProviderCallback(publicUrl, provider.id);
  const loopback = isLoopbackPublicUrl(publicUrl);
  if (!requested) return hosted;
  if (requested === hosted || requested === legacy) return requested;
  // The dev loopback callback is only a valid landing place when Botpasses itself runs on loopback.
  if (requested === LOOPBACK_REDIRECT && loopback) return requested;
  throw new HttpError(400, loopback ? `redirect_uri must be the Botpasses callback or ${LOOPBACK_REDIRECT}` : "redirect_uri must be the Botpasses callback");
}

export function sealOauthState(payload: ProviderOauthState, kek: Buffer): string {
  const envelope = encrypt(JSON.stringify(payload), kek, STATE_AAD);
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function openOauthState(state: string, kek: Buffer, now = Date.now()): ProviderOauthState {
  let envelope: { iv: string; ciphertext: string; tag: string };
  try {
    envelope = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
      iv: string;
      ciphertext: string;
      tag: string;
    };
  } catch {
    throw new HttpError(400, "Invalid OAuth state");
  }
  let raw: string;
  try {
    raw = decrypt(envelope, kek, STATE_AAD);
  } catch {
    throw new HttpError(400, "Invalid OAuth state");
  }
  const parsed = JSON.parse(raw) as ProviderOauthState;
  if (!parsed.orgId || !parsed.clientId || !parsed.redirectUri || !isProviderId(String(parsed.providerId))) {
    throw new HttpError(400, "Invalid OAuth state");
  }
  if (parsed.exp < now) throw new HttpError(410, "OAuth state expired");
  return parsed;
}

/** The provider's authorize URL with response_type=code, scopes, state, and PKCE when enabled. */
export function authorizeUrl(
  provider: Provider,
  input: { clientId: string; redirectUri: string; state: string; codeVerifier: string; scopes?: string[] },
): string {
  if (!provider.authorizeUrl) {
    throw new HttpError(400, `${provider.displayName} has no user connect flow`, { provider: provider.id });
  }
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  const scopes = input.scopes ?? provider.defaultScopes ?? [];
  if (scopes.length === 0 && provider.scopesRequired) {
    throw new HttpError(400, `${provider.displayName} requires at least one scope on the authorize request`, {
      provider: provider.id,
      status: "scopes_required",
    });
  }
  if (provider.scopesParam && scopes.length > 0) {
    url.searchParams.set(provider.scopesParam, scopes.join(provider.scopesDelimiter ?? " "));
  }
  for (const [key, value] of Object.entries(provider.authorizeParams ?? {})) url.searchParams.set(key, value);
  url.searchParams.set("state", input.state);
  if (provider.pkce) {
    url.searchParams.set("code_challenge", pkceChallenge(input.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}
