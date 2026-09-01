/** Username is HTTP Basic only. Secret + bearer/header items do not use it. */
export function needsLoginUsername(kind: string, inject: string): boolean {
  return kind === "login" || inject === "basic";
}

/** Kind picks the usual send method. Operators should not have to know HTTP schemes. */
export function defaultInjectForKind(kind: string): "bearer" | "basic" {
  return kind === "login" ? "basic" : "bearer";
}

export function injectSummary(inject: string): string {
  if (inject === "basic") return "Sent as HTTP Basic (username + password).";
  if (inject === "header:Authorization") {
    return "Sent as a raw Authorization header, with no Bearer prefix.";
  }
  return "Sent as Authorization: Bearer. Typical for API tokens.";
}
