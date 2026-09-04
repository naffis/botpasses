/**
 * Generic OAuth2 token engine: client-credentials mint, refresh-token exchange, and the
 * authorization-code exchange, all driven by a Provider record. Values never leave the process;
 * every body returned to a caller is redacted.
 */
import type { OauthGrantType } from "../../hosted-types.ts";
import { last4 } from "../../ids.ts";
import { redactOauthJson } from "../../redact.ts";
import { executeConnector, redactConnectorBody, type ConnectorFetch, type ConnectorItem, type ConnectorResult, type PinnedTlsOpts, redactOriginHeaders } from "../connector.ts";
import { HttpError, InjectDeniedError } from "../errors.ts";
import type { MintedToken, Provider } from "./types.ts";

export type TokenEngineDeps = {
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  tls?: PinnedTlsOpts;
};

export type MintOutcome = { minted: MintedToken; origin: ConnectorResult };

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

/** Parse a token endpoint's JSON. Throws 502 on anything that is not a bearer token payload. */
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
  type TokenBody = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown };
  const top = parsed as TokenBody & { authed_user?: unknown };
  // Slack's oauth.v2.access keeps the top level for the bot token and carries the user token (and
  // its refresh token) under `authed_user`; with user scopes only there is no top-level token.
  const nested = top.authed_user && typeof top.authed_user === "object" ? (top.authed_user as TokenBody) : undefined;
  const rec: TokenBody = typeof top.access_token === "string" && top.access_token.length > 0 ? top : nested ?? top;
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

/**
 * The stored client-secret item, retargeted at the provider token host with the public client
 * id. `client_credentials` at a token endpoint places the id and secret per `provider.tokenAuth`.
 */
function tokenEndpointItem(provider: Provider, item: ConnectorItem, clientId: string): ConnectorItem {
  return {
    ...item,
    username: clientId,
    inject: "client_credentials",
    allowedHosts: assertTokenHostAllowed(item, provider),
  };
}

function failedMint(): MintedToken {
  return { accessToken: "", expiresAt: 0, last4: "", tokenType: "Bearer" };
}

/**
 * One POST to the provider token endpoint as `tokenItem`. The body and headers handed back are
 * redacted for `originalItem` under the client id actually sent, for `extraSecrets` (a refresh
 * token that travelled in the form), and for the tokens the endpoint minted.
 */
async function postTokenRequest(
  provider: Provider,
  tokenItem: ConnectorItem,
  originalItem: ConnectorItem,
  fields: Record<string, string>,
  deps: TokenEngineDeps,
  extraSecrets: readonly string[] = [],
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
  // Redact against the client id the request carried, not only the stored username.
  const sentAs = tokenItem.username;
  const redacted = (extra: readonly string[]): ConnectorResult => ({
    ...origin,
    body: redactConnectorBody(redactOauthJson(origin.body, provider.redactKeys), originalItem, extra, undefined, sentAs),
    headers: redactOriginHeaders(origin.headers, originalItem, [...extra], sentAs),
  });
  if (origin.status < 200 || origin.status >= 300) {
    return { minted: failedMint(), origin: redacted(extraSecrets) };
  }
  const minted = readMintedAccessToken(origin.body);
  return {
    minted,
    origin: redacted([...extraSecrets, minted.accessToken, ...(minted.refreshToken ? [minted.refreshToken] : [])]),
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
  return postTokenRequest(provider, tokenEndpointItem(provider, item, clientId), item, fields, deps);
}

/**
 * RFC 6749 section 6: a fresh access token from a stored refresh token. The exchange authenticates
 * the app exactly as the code exchange did: `clientSecretItem` (the `<ITEM>` whose
 * `<ITEM>_REFRESH` this is) goes out per `provider.tokenAuth` (HTTP Basic, or `client_id` and
 * `client_secret` form fields), and the refresh item's value rides in the form as `refresh_token`.
 * Both items must allow the token host. Neither value reaches the returned body or headers.
 */
export async function refreshAccessToken(
  provider: Provider,
  refreshItem: ConnectorItem,
  clientSecretItem: ConnectorItem,
  clientId: string,
  deps: TokenEngineDeps = {},
): Promise<MintOutcome> {
  assertGrant(provider, "refresh_token");
  assertTokenHostAllowed(refreshItem, provider);
  return postTokenRequest(
    provider,
    tokenEndpointItem(provider, clientSecretItem, clientId),
    clientSecretItem,
    { grant_type: "refresh_token", refresh_token: refreshItem.secret },
    deps,
    [refreshItem.secret],
  );
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
  return postTokenRequest(provider, tokenEndpointItem(provider, clientSecretItem, input.clientId), clientSecretItem, fields, deps);
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

/** A one-call approval is spent by any origin answer; the model must not expect it to come back. */
const APPROVAL_SPENT = "A one-call approval is spent by this answer; if the retry returns a pending grant, tell the user to approve it.";

export function mintFailedHint(provider: Provider): string {
  return (
    `${provider.displayName} token mint failed at ${provider.tokenHost}${provider.tokenPath}. ` +
    `Check the client id and that the secret is the current one, then retry. ${APPROVAL_SPENT}`
  );
}

export function emptyOriginHint(status: number): string | undefined {
  if (status === 410) {
    return (
      "Upstream returned 410 with an empty body. This is the origin status, not a Botpasses consume error. " +
      `Retry the call once. ${APPROVAL_SPENT}`
    );
  }
  if (status === 401) {
    return (
      "Upstream 401: missing or invalid access token. A client secret is not a user access token. " +
      `Fix the request before retrying. ${APPROVAL_SPENT}`
    );
  }
  return undefined;
}
