export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.extra = extra;
  }
}

export type NeedItemPayload = {
  status: "need_item";
  collect_url: string;
  suggested_name: string;
  host: string;
  client_name: string;
  need_id: string;
  message: string;
};

export class NeedItemError extends HttpError {
  readonly payload: NeedItemPayload;
  constructor(payload: NeedItemPayload) {
    super(404, payload.message);
    this.name = "NeedItemError";
    this.payload = payload;
  }
}

/** 403 `inject_denied`: no active grant admits this client and item. The connector asks for one. */
export class InjectDeniedError extends HttpError {
  constructor(extra: Record<string, unknown> = {}) {
    super(403, "inject_denied", extra);
    this.name = "InjectDeniedError";
  }
}

/**
 * 403 `scope_denied`: an active grant exists but its scope does not admit this call. `extra`
 * carries `status`, `reason`, `grant_id`, and the public `grant_scope`, never the secret.
 */
export class ScopeDeniedError extends HttpError {
  constructor(extra: Record<string, unknown>) {
    super(403, "scope_denied", { status: "scope_denied", ...extra });
    this.name = "ScopeDeniedError";
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

export function isNeedItemError(err: unknown): err is NeedItemError {
  return err instanceof NeedItemError;
}

export function isInjectDenied(err: unknown): err is InjectDeniedError {
  return err instanceof InjectDeniedError;
}

export function isScopeDenied(err: unknown): err is ScopeDeniedError {
  return err instanceof ScopeDeniedError;
}
