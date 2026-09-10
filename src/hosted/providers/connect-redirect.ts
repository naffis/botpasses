/**
 * The redirect URI a vendor app must allowlist for a Botpasses user connect.
 * One hosted path for every provider; loopback only when Botpasses itself is local.
 */
export const LOOPBACK_REDIRECT = "http://127.0.0.1:8888/callback";
export const HOSTED_CONNECT_CALLBACK_PATH = "/connect/callback";

export function isLoopbackPublicUrl(publicUrl: string): boolean {
  return publicUrl.startsWith("http://127.0.0.1") || publicUrl.startsWith("http://localhost");
}

/** The URI `chooseRedirect` sends when the caller does not ask for another allowlisted one. */
export function defaultConnectRedirect(publicUrl: string): string {
  const origin = publicUrl.replace(/\/$/, "");
  if (isLoopbackPublicUrl(origin)) return LOOPBACK_REDIRECT;
  return `${origin}${HOSTED_CONNECT_CALLBACK_PATH}`;
}

/** Expand-only alias: older connects registered `/integrations/<provider>/callback`. */
export function legacyProviderCallback(publicUrl: string, providerId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/integrations/${providerId}/callback`;
}
