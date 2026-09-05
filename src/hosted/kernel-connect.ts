/**
 * Provider user connect (authorization_code, PKCE where the provider supports it) for the hosted
 * kernel. The sealed state carries the provider id so the callback rejects a state minted for
 * another provider; the refresh token lands in the vault as `<ITEM>_REFRESH`. Functions take a
 * `ConnectHost`; `HostedKernel` delegates here and keeps the KEK behind `sealState`/`openState`.
 */
import { randomUUID } from "node:crypto";
import { unscopedFields, type ClientRecord, type EnvironmentRecord, type ItemPublic, type VaultEnvName } from "../hosted-types.ts";
import type { VaultStore } from "../store/types.ts";
import type { ConnectorFetch } from "./connector.ts";
import { HttpError } from "./errors.ts";
import { normalizeItemName, type CreateItemInput, type DecryptedItem, type UpdateItemInput } from "./kernel-items.ts";
import { exchangeAuthorizationCode, refreshItemName } from "./providers/oauth.ts";
import { providerById } from "./providers/registry.ts";
import type { Provider, ProviderId } from "./providers/types.ts";
import { authorizeUrl, chooseRedirect, pkceVerifier, type ProviderOauthState } from "./providers/user-oauth.ts";

const STATE_TTL_MS = 10 * 60 * 1000;

export type ConnectHost = {
  store: VaultStore;
  now: () => Date;
  publicUrl: string;
  sealState: (payload: ProviderOauthState) => string;
  openState: (state: string) => ProviderOauthState;
  envFor: (orgId: string, name: VaultEnvName) => Promise<EnvironmentRecord>;
  clientInOrg: (orgId: string, clientId: string) => Promise<ClientRecord>;
  decryptItem: (orgId: string, itemId: string) => Promise<DecryptedItem>;
  createItem: (input: CreateItemInput) => Promise<ItemPublic>;
  updateItem: (input: UpdateItemInput) => Promise<ItemPublic>;
  audit: (orgId: string, action: string, actor: string, itemName: string | null, clientId: string | null) => Promise<void>;
};

export type StartConnectInput = {
  providerId: string;
  orgId: string;
  userId: string;
  itemName: string;
  environment: VaultEnvName;
  clientId?: string;
  redirectUri?: string;
  /** The one model client that gets an `item_standing` policy on the refresh item after connect. */
  agentClientId?: string;
};

export type StartConnectResult = { authorize_url: string; redirect_uri: string; provider: ProviderId };

export type FinishConnectInput = {
  /** The callback route's `:provider`; when given, the state must have been minted for it. */
  providerId?: string;
  orgId: string;
  userId: string;
  state: string;
  code: string;
  fetchImpl?: ConnectorFetch;
};

export type FinishConnectResult = { item_name: string; last4: string; provider: ProviderId };

/** A registry provider with a user connect flow; 404 for unknown ids, 400 when it has no authorize URL. */
function connectProvider(providerId: string): Provider {
  const provider = providerById(providerId);
  if (!provider) throw new HttpError(404, "Unknown provider", { provider: providerId });
  if (!provider.authorizeUrl) {
    throw new HttpError(400, `${provider.displayName} has no user connect flow`, { provider: provider.id });
  }
  return provider;
}

/**
 * Starts the user connect for `providerId` against a stored client-secret item. Without
 * `agentClientId` no policy is written and the operator approves normally.
 */
export async function startProviderUserOauth(host: ConnectHost, input: StartConnectInput): Promise<StartConnectResult> {
  const provider = connectProvider(input.providerId);
  const env = await host.envFor(input.orgId, input.environment);
  const item = await host.store.getItemByName(env.id, normalizeItemName(input.itemName));
  if (!item) throw new HttpError(404, "Unknown item");
  const clientId = (input.clientId ?? item.username ?? "").trim();
  if (!clientId) {
    throw new HttpError(400, `${provider.displayName} Client ID is required (item username or client_id)`);
  }
  const agentClientId = input.agentClientId?.trim() || undefined;
  if (agentClientId) {
    const agent = await host.clientInOrg(input.orgId, agentClientId);
    if (agent.kind !== "model" || agent.revokedAt) throw new HttpError(400, "agent_client_id must be an active model client");
  }
  const redirectUri = chooseRedirect(provider, host.publicUrl, input.redirectUri);
  const codeVerifier = pkceVerifier();
  const state = host.sealState({
    providerId: provider.id,
    orgId: input.orgId,
    userId: input.userId,
    itemId: item.id,
    itemName: item.name,
    environment: input.environment,
    clientId,
    redirectUri,
    codeVerifier,
    exp: host.now().getTime() + STATE_TTL_MS,
    ...(agentClientId ? { agentClientId } : {}),
  });
  return {
    authorize_url: authorizeUrl(provider, { clientId, redirectUri, state, codeVerifier }),
    redirect_uri: redirectUri,
    provider: provider.id,
  };
}

/**
 * Exchanges the callback code with the client-secret item and stores the refresh token as
 * `<ITEM>_REFRESH` (`inject: refresh`, allowed on the provider's API and token hosts).
 */
/** Why a connect callback failed, as the console query string carries it (`connect_error` + `reason`). */
export type ConnectErrorReason = "state_expired" | "provider_denied" | "exchange_failed" | "no_refresh_token";

/** The reason code on a connect failure, or `exchange_failed` for anything without one. */
export function connectErrorReason(err: unknown): ConnectErrorReason {
  const reason = err instanceof HttpError ? err.extra.reason : undefined;
  if (reason === "state_expired" || reason === "provider_denied" || reason === "exchange_failed" || reason === "no_refresh_token") {
    return reason;
  }
  return "exchange_failed";
}

export async function finishProviderUserOauth(host: ConnectHost, input: FinishConnectInput): Promise<FinishConnectResult> {
  let opened: ProviderOauthState;
  try {
    opened = host.openState(input.state);
  } catch (err) {
    // Malformed, forged, or expired: the operator restarts the connect either way.
    throw new HttpError(err instanceof HttpError ? err.status : 400, "OAuth state is invalid or expired", { reason: "state_expired" });
  }
  if (input.providerId !== undefined && opened.providerId !== input.providerId) {
    throw new HttpError(400, "OAuth state is for another provider", { provider: opened.providerId, reason: "state_expired" });
  }
  const provider = connectProvider(opened.providerId);
  if (opened.orgId !== input.orgId) throw new HttpError(403, "OAuth state is not for this org", { reason: "state_expired" });
  // The account that started the connect must finish it: a state sealed for one operator
  // cannot bind a different operator's provider account to the item.
  if (opened.userId !== input.userId) throw new HttpError(403, "OAuth state is not for this account", { reason: "state_expired" });
  const item = await host.store.getItem(opened.itemId);
  if (!item) throw new HttpError(404, "Unknown item", { reason: "exchange_failed" });
  const decrypted = await host.decryptItem(input.orgId, item.id);
  const exchange = await exchangeAuthorizationCode(
    provider,
    decrypted,
    {
      clientId: opened.clientId,
      code: input.code,
      redirectUri: opened.redirectUri,
      codeVerifier: opened.codeVerifier,
    },
    { fetchImpl: input.fetchImpl },
  );
  if (exchange.origin.status < 200 || exchange.origin.status >= 300) {
    throw new HttpError(
      exchange.origin.status >= 400 ? exchange.origin.status : 502,
      `${provider.displayName} code exchange failed`,
      { reason: "exchange_failed" },
    );
  }
  const refresh = exchange.minted.refreshToken;
  if (!refresh) {
    throw new HttpError(502, `${provider.displayName} did not return a refresh token`, { reason: "no_refresh_token" });
  }
  const name = refreshItemName(opened.itemName);
  const envName = opened.environment === "production" ? "production" : "staging";
  const env = await host.envFor(input.orgId, envName);
  const existing = await host.store.getItemByName(env.id, name);
  const allowedHosts = [...new Set([...provider.apiHosts, provider.tokenHost])];
  let last: string;
  let refreshId = existing?.id ?? "";
  if (existing) {
    // Reset how the refresh token may be sent, not only its value: an `<ITEM>_REFRESH` row
    // someone stored earlier with other hosts or another inject mode must not receive a
    // token the connecting operator never meant to send there.
    const rotated = await host.updateItem({
      orgId: input.orgId,
      actor: input.userId,
      itemId: existing.id,
      value: refresh,
      username: opened.clientId,
      allowedHosts,
      inject: "refresh",
    });
    last = rotated.last4;
  } else {
    const created = await host.createItem({
      orgId: input.orgId,
      actor: input.userId,
      environment: envName,
      kind: "secret",
      name,
      value: refresh,
      username: opened.clientId,
      allowedHosts,
      inject: "refresh",
    });
    last = created.last4;
    refreshId = created.id;
  }
  await host.audit(input.orgId, "provider_connected", input.userId, name, null);
  if (opened.agentClientId) {
    const agent = await host.clientInOrg(input.orgId, opened.agentClientId);
    const have = await host.store.findItemPolicy(input.orgId, agent.id, refreshId);
    if (agent.kind === "model" && !agent.revokedAt && !have) {
      await host.store.insertPolicy({
        id: `pol_${randomUUID()}`,
        orgId: input.orgId,
        clientId: agent.id,
        itemId: refreshId,
        folderId: null,
        environmentId: env.id,
        kind: "item_standing",
        createdAt: host.now().toISOString(),
        ...unscopedFields(),
        expiresAt: null,
      });
      await host.audit(input.orgId, "grant", input.userId, name, agent.id);
    }
  }
  return { item_name: name, last4: last, provider: provider.id };
}
