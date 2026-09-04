/**
 * OAuth client policy and the access-ledger writes that happen when tokens are
 * issued or revoked. Pure helpers plus kernel calls; no provider wiring here.
 */
import { errors as oidcErrors, type ProviderContext } from "oidc-provider";
import type { VaultEnvName } from "../hosted-types.ts";
import type { HostedKernel } from "./kernel.ts";
import { hashToken } from "./operator-identity.ts";
import { logVaultEvent } from "./observe.ts";

const BLOCKED_REDIRECT_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:"]);

/**
 * Desktop MCP hosts that redirect to a private-use scheme instead of https or
 * loopback http. This is the whole list: an unknown scheme is rejected so a
 * registration cannot claim `com.attacker.app://` and phish the consent page.
 */
export const DESKTOP_REDIRECT_SCHEMES: ReadonlySet<string> = new Set([
  "cursor:",
  "cursor-mcp:",
  "vscode:",
  "vscode-insiders:",
  "grok:",
  "xai:",
  "xai-grok:",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

export function isDesktopRedirect(uri: string): boolean {
  try {
    return DESKTOP_REDIRECT_SCHEMES.has(new URL(uri).protocol);
  } catch {
    return false;
  }
}

/**
 * Accepts https, loopback http on an IP literal (`http://127.0.0.1:<port>`,
 * `http://[::1]:<port>`, RFC 8252 section 7.3), and the named desktop schemes.
 * `http://localhost` is refused: it can resolve off-box.
 */
export function assertRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("invalid redirect_uri");
  }
  if (BLOCKED_REDIRECT_SCHEMES.has(parsed.protocol)) {
    throw new Error("redirect_uri scheme is not allowed");
  }
  if (parsed.username || parsed.password) throw new Error("redirect_uri must not carry credentials");
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return;
  if (DESKTOP_REDIRECT_SCHEMES.has(parsed.protocol)) return;
  throw new Error("redirect_uri must be https, loopback http (127.0.0.1 or [::1]), or a known desktop app scheme");
}

/** Hostnames (or scheme labels for desktop apps) an operator can check against on the consent page. */
export function redirectHosts(uris: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const uri of uris ?? []) {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") out.add(parsed.host);
      else out.add(`${parsed.protocol}//`);
    } catch {
      continue;
    }
  }
  return [...out];
}

/** `extraClientMetadata.validator`: runs for DCR and CIMD clients alike. */
export function clientMetadataValidator(
  _ctx: ProviderContext | undefined,
  key: string,
  value: unknown,
  metadata: Record<string, unknown>,
): void {
  if (key === "client_name" && typeof value === "string" && value.length > 80) {
    throw new oidcErrors.InvalidClientMetadata("client_name too long");
  }
  delete metadata.logo_uri;
  delete metadata.policy_uri;
  const uris = metadata.redirect_uris;
  if (Array.isArray(uris)) {
    for (const uri of uris) {
      if (typeof uri !== "string") {
        throw new oidcErrors.InvalidClientMetadata("invalid redirect_uri");
      }
      try {
        assertRedirectUri(uri);
      } catch (err) {
        throw new oidcErrors.InvalidClientMetadata(err instanceof Error ? err.message : "invalid redirect_uri");
      }
    }
    if (uris.some((uri) => typeof uri === "string" && isDesktopRedirect(uri))) {
      metadata.application_type = "native";
    }
  }
}

export type IssuedTokenInput = {
  jti: string;
  oauthClientId: string;
  accountId?: string;
  exp?: number;
  /** DCR or CIMD `client_name`; the vault client is named after it on first issue. */
  clientName?: string;
};

export function logLedgerPersistFailure(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logVaultEvent("ledger_persist_failed", { kind, message: message.slice(0, 200) });
}

export async function persistRevokedToken(kernel: HostedKernel, jti: string): Promise<void> {
  const existing = await kernel.store.getAccessEventByJti(hashToken(jti));
  if (!existing || existing.revokedAt) return;
  const at = new Date().toISOString();
  await kernel.store.revokeAccessEvent(existing.jtiHash, at);
  await kernel.writeAudit(
    existing.orgId,
    "token_revoked",
    existing.actorUserId ?? existing.clientId ?? "oauth",
    null,
    existing.clientId,
  );
}

function vaultClientName(input: IssuedTokenInput): string {
  const name = input.clientName?.trim();
  return (name || input.oauthClientId).slice(0, 80);
}

/**
 * Records an issued OAuth token on the access ledger and makes sure the operator's
 * org has a vault client for this OAuth client id. The vault client lives in the
 * plane's default environment (`environment`), never a hard-coded one, and remembers
 * which account consented so revocation can stay inside that account.
 */
async function persistIssuedOauth(
  kernel: HostedKernel,
  kind: "oauth_access" | "oauth_refresh",
  input: IssuedTokenInput,
  environment: VaultEnvName,
): Promise<void> {
  const existing = await kernel.store.getAccessEventByJti(hashToken(input.jti));
  if (existing) return;
  if (!input.accountId) throw new Error("token missing account");
  const orgUser = await kernel.ensureVaultOrgForUser(input.accountId);
  const client = await kernel.ensureModelClient({
    orgId: orgUser.orgId,
    name: vaultClientName(input),
    environment,
    clerkOauthUserId: input.oauthClientId,
  });
  if (!client.consentedByUserId) {
    await kernel.store.setClientConsentedBy(client.id, input.accountId);
  }
  const at = new Date().toISOString();
  await kernel.recordAccessEvent({
    orgId: orgUser.orgId,
    clientId: client.id,
    actorUserId: input.accountId,
    kind,
    jtiHash: hashToken(input.jti),
    issuedAt: at,
    expiresAt: input.exp ? new Date(input.exp * 1000).toISOString() : null,
  });
  await kernel.store.setClientLastTokenAt(client.id, at);
  await kernel.writeAudit(orgUser.orgId, "token_issued", input.accountId, null, client.id);
}

export async function persistIssuedAccess(
  kernel: HostedKernel,
  input: IssuedTokenInput,
  environment: VaultEnvName = kernel.deployPlane,
): Promise<void> {
  return persistIssuedOauth(kernel, "oauth_access", input, environment);
}

export async function persistIssuedRefresh(
  kernel: HostedKernel,
  input: IssuedTokenInput,
  environment: VaultEnvName = kernel.deployPlane,
): Promise<void> {
  return persistIssuedOauth(kernel, "oauth_refresh", input, environment);
}

export type TokenRefView = { jti?: string; clientId?: string; accountId?: string; exp?: number };

export function asTokenRef(value: unknown): TokenRefView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  return {
    jti: typeof rec.jti === "string" ? rec.jti : undefined,
    clientId: typeof rec.clientId === "string" ? rec.clientId : undefined,
    accountId: typeof rec.accountId === "string" ? rec.accountId : undefined,
    exp: typeof rec.exp === "number" ? rec.exp : undefined,
  };
}
