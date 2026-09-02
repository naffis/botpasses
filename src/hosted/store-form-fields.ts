/** Username is HTTP Basic or an OAuth client id. Secret + bearer/header items do not use it. */
export function needsLoginUsername(kind: string, inject: string): boolean {
  return kind === "login" || inject === "basic" || inject === "client_credentials" || inject === "refresh";
}

/** Kind picks the usual send method. Operators should not have to know HTTP schemes. */
export function defaultInjectForKind(kind: string): "bearer" | "basic" | "client_credentials" {
  return kind === "login" ? "basic" : "bearer";
}

export function injectSummary(inject: string): string {
  if (inject === "basic") return "Sent as HTTP Basic (username + password).";
  if (inject === "client_credentials") {
    return "OAuth client secret. Token mint uses HTTP Basic (client_id:secret) and a form body. Not a user access token.";
  }
  if (inject === "header:Authorization") {
    return "Sent as a raw Authorization header, with no Bearer prefix.";
  }
  return "Sent as Authorization: Bearer. Typical for API tokens. A Client Secret is not an access token.";
}

export function storedItemUsername(kind: string, inject: string, username?: string | null): string | null {
  if (!needsLoginUsername(kind, inject)) return null;
  const value = username?.trim();
  return value ? value : null;
}
