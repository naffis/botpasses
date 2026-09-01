declare module "oidc-provider" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  export class InvalidTarget extends Error {
    constructor(message?: string);
  }

  export class InvalidClientMetadata extends Error {
    constructor(description?: string, options?: unknown);
  }

  export const errors: {
    InvalidTarget: typeof InvalidTarget;
    InvalidClientMetadata: typeof InvalidClientMetadata;
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

  export default class Provider {
    constructor(issuer: string, config?: Record<string, unknown>);
    Grant: new (opts: { accountId: string; clientId: string }) => Grant;
    AuthorizationCode: new (opts: Record<string, unknown>) => AuthorizationCode;
    Client: { find(id: string): Promise<{ clientId: string } | undefined> };
    callback(): (
      req: IncomingMessage,
      res: ServerResponse,
      next?: (err?: unknown) => void,
    ) => void;
    on(event: string, listener: (...args: unknown[]) => void): this;
    interactionDetails(req: IncomingMessage, res: ServerResponse): Promise<unknown>;
    interactionFinished(
      req: IncomingMessage,
      res: ServerResponse,
      result: Record<string, unknown>,
      opts?: { mergeWithLastSubmission?: boolean },
    ): Promise<void>;
  }
}
