/**
 * User connect (authorization_code, optionally PKCE) for any provider with an authorizeUrl.
 * State is sealed under the plane KEK so the callback cannot be forged or replayed across orgs.
 */
import { createHash, randomBytes } from "node:crypto";
import { decrypt, encrypt } from "../../crypto.ts";
import { HttpError } from "../errors.ts";
import type { Provider, ProviderId } from "./types.ts";
import { isProviderId } from "./registry.ts";

export const LOOPBACK_REDIRECT = "http://127.0.0.1:8888/callback";
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
};

export function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** `${publicUrl}/integrations/<provider>/callback`. */
export function hostedRedirect(provider: Provider, publicUrl: string): string {
  return `${publicUrl.replace(/\/$/, "")}/integrations/${provider.id}/callback`;
}

/**
 * The redirect URI the authorize request will carry. Only the hosted callback or the loopback
 * dev callback are accepted so a stolen state cannot send the code elsewhere.
 */
export function chooseRedirect(provider: Provider, publicUrl: string, requested?: string): string {
  const hosted = hostedRedirect(provider, publicUrl);
  if (!requested) {
    return publicUrl.startsWith("http://127.0.0.1") || publicUrl.startsWith("http://localhost")
      ? LOOPBACK_REDIRECT
      : hosted;
  }
  if (requested === hosted || requested === LOOPBACK_REDIRECT) return requested;
  throw new HttpError(400, `redirect_uri must be the Botpasses callback or ${LOOPBACK_REDIRECT}`);
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
  if (provider.scopesParam && scopes.length > 0) url.searchParams.set(provider.scopesParam, scopes.join(" "));
  url.searchParams.set("state", input.state);
  if (provider.pkce) {
    url.searchParams.set("code_challenge", pkceChallenge(input.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}
