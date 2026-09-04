/**
 * Local typing for oidc-provider 9.12, which ships no `.d.ts` and has no bundled
 * `@types` in this tree. Only the configuration keys and runtime surface Botpasses
 * uses are declared; add to it when a new option is wired, never widen to `any`.
 */
declare module "oidc-provider" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  export class OIDCProviderError extends Error {
    constructor(message?: string, description?: string);
    readonly error: string;
    readonly error_description?: string;
    readonly statusCode: number;
  }
  export class InvalidTarget extends OIDCProviderError {}
  export class InvalidClient extends OIDCProviderError {}
  export class InvalidRequest extends OIDCProviderError {}
  export class InvalidClientMetadata extends OIDCProviderError {}
  export class SessionNotFound extends InvalidRequest {}

  export const errors: {
    InvalidTarget: typeof InvalidTarget;
    InvalidClient: typeof InvalidClient;
    InvalidRequest: typeof InvalidRequest;
    InvalidClientMetadata: typeof InvalidClientMetadata;
    SessionNotFound: typeof SessionNotFound;
  };

  export type CookieAttributes = {
    httpOnly?: boolean;
    sameSite?: "lax" | "strict" | "none";
    secure?: boolean;
    path?: string;
    maxAge?: number;
    signed?: boolean;
  };

  /** Registered client as oidc-provider exposes it: metadata keys are camelCased. */
  export type ClientView = {
    clientId: string;
    clientName?: string;
    redirectUris?: string[];
    applicationType?: string;
    tokenEndpointAuthMethod?: string;
  };

  /** The parts of a Koa context Botpasses reads or writes from hooks. */
  export type ProviderContext = {
    req: IncomingMessage;
    res: ServerResponse;
    body: unknown;
    type: string;
    status: number;
    secure: boolean;
    cookies: {
      get(name: string, attrs?: CookieAttributes): string | undefined;
      set(name: string, value: string | null, attrs?: CookieAttributes): void;
    };
    oidc?: {
      session?: { state?: { secret?: string } };
      client?: ClientView;
      params?: Record<string, unknown>;
    };
  };

  export type TokenRef = {
    kind?: string;
    jti?: string;
    clientId?: string;
    accountId?: string;
    grantId?: string;
    exp?: number;
  };

  export type Account = {
    accountId: string;
    claims(): Promise<Record<string, unknown>>;
  };

  export type InteractionDetails = {
    uid: string;
    params: Record<string, unknown>;
    prompt: { name: string; reasons: string[]; details: Record<string, unknown> };
    session?: { accountId?: string; uid?: string };
    grantId?: string;
    lastSubmission?: Record<string, unknown>;
    returnTo: string;
  };

  export type InteractionResult = {
    login?: { accountId: string; remember?: boolean; amr?: string[]; acr?: string };
    consent?: { grantId?: string };
    error?: string;
    error_description?: string;
  };

  export type ResourceServerInfo = {
    scope: string;
    audience: string;
    accessTokenFormat: "jwt" | "opaque";
    accessTokenTTL?: number;
  };

  export type AdapterPayload = Record<string, unknown>;
  export type AdapterInstance = {
    upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void>;
    find(id: string): Promise<AdapterPayload | undefined>;
    findByUid(uid: string): Promise<AdapterPayload | undefined>;
    findByUserCode(userCode: string): Promise<AdapterPayload | undefined>;
    destroy(id: string): Promise<void>;
    revokeByGrantId(grantId: string): Promise<void>;
    consume(id: string): Promise<void>;
  };
  export type AdapterConstructor = new (kind: string) => AdapterInstance;

  export type DeviceFlowFeature = {
    enabled: boolean;
    charset?: "base-20" | "digits";
    mask?: string;
    userCodeInputSource(
      ctx: ProviderContext,
      form: string,
      out: Record<string, unknown> | undefined,
      err: (Error & { userCode?: string }) | undefined,
    ): void | Promise<void>;
    userCodeConfirmSource(
      ctx: ProviderContext,
      form: string,
      client: ClientView,
      deviceInfo: Record<string, unknown>,
      userCode: string,
    ): void | Promise<void>;
    successSource(ctx: ProviderContext): void | Promise<void>;
  };

  export type ProviderConfiguration = {
    adapter: AdapterConstructor;
    clients: Record<string, unknown>[];
    cookies: {
      keys: string[];
      short: CookieAttributes;
      long: CookieAttributes;
    };
    pkce: { required(ctx: ProviderContext, client: ClientView): boolean };
    routes: Record<string, string>;
    features: {
      devInteractions: { enabled: boolean };
      resourceIndicators: {
        enabled: boolean;
        defaultResource(ctx: ProviderContext, client: ClientView): string | Promise<string>;
        getResourceServerInfo(
          ctx: ProviderContext,
          resourceIndicator: string,
          client: ClientView,
        ): ResourceServerInfo | Promise<ResourceServerInfo>;
        useGrantedResource(ctx: ProviderContext, model: unknown): boolean | Promise<boolean>;
      };
      registration: { enabled: boolean; idFactory(ctx: ProviderContext): string };
      registrationManagement: { enabled: boolean };
      deviceFlow: DeviceFlowFeature;
      revocation: { enabled: boolean };
      clientIdMetadataDocument?: {
        enabled: boolean;
        ack: string;
        allowFetch?(ctx: ProviderContext | undefined, clientId: string): boolean | Promise<boolean>;
        allowClient?(ctx: ProviderContext | undefined, client: ClientView): boolean | Promise<boolean>;
        cacheDuration?: { min: number; max: number };
      };
    };
    findAccount(ctx: ProviderContext, id: string, token?: TokenRef): Account | Promise<Account | undefined> | undefined;
    interactions: { url(ctx: ProviderContext, interaction: { uid: string }): string | Promise<string> };
    extraClientMetadata: {
      properties: string[];
      validator(ctx: ProviderContext | undefined, key: string, value: unknown, metadata: Record<string, unknown>): void;
    };
    extraTokenClaims(
      ctx: ProviderContext,
      token: TokenRef,
    ): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
    jwks: { keys: Record<string, unknown>[] };
    issueRefreshToken(ctx: ProviderContext, client: ClientView, code: TokenRef): boolean | Promise<boolean>;
    rotateRefreshToken(ctx: ProviderContext): boolean | Promise<boolean>;
    scopes: string[];
    clientDefaults: Record<string, unknown>;
    ttl: Record<string, number>;
    renderError(ctx: ProviderContext, out: Record<string, unknown>, err: Error): void | Promise<void>;
    fetch(url: string, options: RequestInit): Promise<Response>;
  };

  export class Grant {
    constructor(opts: { accountId: string; clientId: string });
    addOIDCScope(scope: string): void;
    addResourceScope(resource: string, scope: string): void;
    save(): Promise<string>;
  }

  export class AuthorizationCode {
    constructor(opts: Record<string, unknown>);
    save(): Promise<string>;
  }

  export class Session {
    static get(ctx: ProviderContext): Promise<Session>;
    readonly new?: boolean;
    readonly id: string;
    accountId?: string;
    destroy(): Promise<void>;
  }

  export type ClientModel = {
    find(id: string): Promise<ClientView | undefined>;
  };

  export type ProviderCallback = (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (err?: unknown) => void,
  ) => void;

  export default class Provider {
    constructor(issuer: string, config: ProviderConfiguration);
    /** Koa `app.proxy`: trust X-Forwarded-Proto and friends from the TLS-terminating edge. */
    proxy: boolean;
    readonly issuer: string;
    Grant: typeof Grant;
    AuthorizationCode: typeof AuthorizationCode;
    Session: typeof Session;
    Client: ClientModel;
    createContext(req: IncomingMessage, res: ServerResponse): ProviderContext;
    cookieName(type: "session" | "interaction" | "resume"): string;
    callback(): ProviderCallback;
    on(event: string, listener: (...args: unknown[]) => void): this;
    interactionDetails(req: IncomingMessage, res: ServerResponse): Promise<InteractionDetails>;
    interactionFinished(
      req: IncomingMessage,
      res: ServerResponse,
      result: InteractionResult,
      opts?: { mergeWithLastSubmission?: boolean },
    ): Promise<void>;
  }
}
