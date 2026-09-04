/**
 * Generic OAuth2 token engine: client-credentials mint, refresh-token exchange, and the
 * authorization-code exchange, all driven by a Provider record. Values never leave the process;
 * every body returned to a caller is redacted.
 */
import type { OauthGrantType } from "../../hosted-types.ts";
import { redactOauthJson } from "../../redact.ts";
import { executeConnector, redactConnectorBody, type ConnectorFetch, type ConnectorItem, type ConnectorResult, type PinnedTlsOpts } from "../connector.ts";
import { HttpError, InjectDeniedError } from "../errors.ts";
import type { MintedToken, Provider } from "./types.ts";

export type TokenEngineDeps = {
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  tls?: PinnedTlsOpts;
};

export type MintOutcome = { minted: MintedToken; origin: ConnectorResult };

function last4(value: string): string {
  return value.length <= 4 ? value : value.slice(-4);
}

/** Parse a token endpoint's JSON. Throws 502 on anything that is not a bearer token payload. */
/** The token endpoint is a send like any other: the operator must have allowlisted it. */
function assertTokenHostAllowed(item: { allowedHosts: string[] }, provider: Provider): string[] {
  if (!item.allowedHosts.includes(provider.tokenHost)) {
    throw new InjectDeniedError(
      {
        status: "inject_denied",
        hint: `Add ${provider.tokenHost} to this credential's allowed hosts to mint or refresh tokens with it.`,
      },
      400,
    );
  }
  return item.allowedHosts;
}

export function readMintedAccessToken(body: string): MintedToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(502, "Token endpoint returned a non-JSON body");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new HttpError(502, "Token endpoint returned a non-object body");
  }
  const rec = parsed as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
  };
  if (typeof rec.access_token !== "string" || rec.access_token.length === 0) {
    throw new HttpError(502, "Token endpoint did not return access_token");
  }
  const expiresIn = typeof rec.expires_in === "number" ? rec.expires_in : 3600;
  return {
    accessToken: rec.access_token,
    refreshToken:
      typeof rec.refresh_token === "string" && rec.refresh_token.length > 0 ? rec.refresh_token : undefined,
    expiresAt: Date.now() + Math.max(30, expiresIn) * 1000,
    last4: last4(rec.access_token),
    tokenType: typeof rec.token_type === "string" ? rec.token_type : "Bearer",
  };
}

/** The stored client-secret item, retargeted at the provider token host with the public client id. */
function tokenEndpointItem(provider: Provider, item: ConnectorItem, clientId: string, inject: "client_credentials" | "refresh"): ConnectorItem {
  return {
    ...item,
    username: clientId,
    inject,
    allowedHosts: assertTokenHostAllowed(item, provider),
  };
}

function failedMint(): MintedToken {
  return { accessToken: "", expiresAt: 0, last4: "", tokenType: "Bearer" };
}

async function postTokenRequest(
  provider: Provider,
  tokenItem: ConnectorItem,
  originalItem: ConnectorItem,
  fields: Record<string, string>,
  deps: TokenEngineDeps,
): Promise<MintOutcome> {
  const origin = await executeConnector(
    tokenItem,
    {
      method: "POST",
      path: provider.tokenPath,
      host: provider.tokenHost,
      body: fields,
      contentType: "application/x-www-form-urlencoded",
    },
    { fetchImpl: deps.fetchImpl, resolveAddresses: deps.resolveAddresses, tls: deps.tls, redact: false },
  );
  if (origin.status < 200 || origin.status >= 300) {
    return {
      minted: failedMint(),
      origin: { ...origin, body: redactConnectorBody(redactOauthJson(origin.body, provider.redactKeys), originalItem) },
    };
  }
  const minted = readMintedAccessToken(origin.body);
  const extra = [minted.accessToken, ...(minted.refreshToken ? [minted.refreshToken] : [])];
  return {
    minted,
    origin: {
      ...origin,
      body: redactConnectorBody(redactOauthJson(origin.body, provider.redactKeys), originalItem, extra),
    },
  };
}

function assertGrant(provider: Provider, grant: OauthGrantType): void {
  if (!provider.grantTypes.includes(grant)) {
    throw new HttpError(400, `${provider.displayName} does not support the ${grant} grant`, {
      status: "grant_unsupported",
      provider: provider.id,
    });
  }
}

/** RFC 6749 section 4.4: an app token from a client id + secret. */
export async function mintClientCredentials(
  provider: Provider,
  item: ConnectorItem,
  clientId: string,
  deps: TokenEngineDeps = {},
  scopes?: string[],
): Promise<MintOutcome> {
  assertGrant(provider, "client_credentials");
  const fields: Record<string, string> = { grant_type: "client_credentials" };
  if (scopes && scopes.length > 0 && provider.scopesParam) fields[provider.scopesParam] = scopes.join(" ");
  return postTokenRequest(provider, tokenEndpointItem(provider, item, clientId, "client_credentials"), item, fields, deps);
}

/**
 * RFC 6749 section 6: a fresh access token from a stored refresh token. The refresh item's value
 * is placed in the form body by the connector (`refresh` mode); `clientId` identifies the app.
 */
export async function refreshAccessToken(
  provider: Provider,
  refreshItem: ConnectorItem,
  clientId: string,
  deps: TokenEngineDeps = {},
): Promise<MintOutcome> {
  assertGrant(provider, "refresh_token");
  return postTokenRequest(provider, tokenEndpointItem(provider, refreshItem, clientId, "refresh"), refreshItem, {}, deps);
}

/** RFC 6749 section 4.1.3 (+ RFC 7636 code_verifier): exchange a code with the client secret item. */
export async function exchangeAuthorizationCode(
  provider: Provider,
  clientSecretItem: ConnectorItem,
  input: { clientId: string; code: string; redirectUri: string; codeVerifier?: string },
  deps: TokenEngineDeps = {},
): Promise<MintOutcome> {
  assertGrant(provider, "authorization_code");
  const fields: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  };
  if (input.codeVerifier) fields.code_verifier = input.codeVerifier;
  return postTokenRequest(
    provider,
    tokenEndpointItem(provider, clientSecretItem, input.clientId, "client_credentials"),
    clientSecretItem,
    fields,
    deps,
  );
}

/** The API-call item: a minted token sent as Bearer, with nothing of the client secret left. */
export function itemWithAccessToken(item: ConnectorItem, accessToken: string): ConnectorItem {
  return {
    ...item,
    secret: accessToken,
    inject: "bearer",
    username: null,
    last4: last4(accessToken),
    kind: "secret",
  };
}

/** `FOO_SECRET` stores its user refresh token as `FOO_REFRESH`; anything else gets `_REFRESH`. */
export function refreshItemName(secretName: string): string {
  return secretName.endsWith("_SECRET") ? secretName.replace(/_SECRET$/, "_REFRESH") : `${secretName}_REFRESH`;
}

/** Public client id for a client-secret item: the argument wins, then the stored username. */
export function resolveClientId(item: { username: string | null }, argsClientId?: string): string | undefined {
  const fromArgs = argsClientId?.trim();
  if (fromArgs) return fromArgs;
  const fromItem = item.username?.trim();
  if (fromItem) return fromItem;
  return undefined;
}

export function isClientSecretShaped(item: { inject: string; kind: string }): boolean {
  return item.kind === "client_secret" || item.inject === "client_credentials" || item.inject === "basic";
}

/** Model-facing hints. Vendor names come from the provider record only. */
export function clientIdRequiredHint(provider: Provider): string {
  return (
    `This item is a ${provider.displayName} client secret, not a user access token. Pass client_id or store ` +
    "the public client id as the item username, then retry. Botpasses mints the app token."
  );
}

export function mintFailedHint(provider: Provider): string {
  return (
    `${provider.displayName} token mint failed at ${provider.tokenHost}${provider.tokenPath}. Retry uses the same ` +
    "approval. Check the client id and that the secret is the current one."
  );
}

export function emptyOriginHint(status: number): string | undefined {
  if (status === 410) {
    return (
      "Upstream returned 410 with an empty body. This is the origin status, not a Botpasses consume error. " +
      "Retry uses the same approval. Do not ask for a new 8-digit code."
    );
  }
  if (status === 401) {
    return (
      "Upstream 401: missing or invalid access token. A client secret is not a user access token. " +
      "Retry uses the same approval."
    );
  }
  return undefined;
}
