export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
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

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

export function isNeedItemError(err: unknown): err is NeedItemError {
  return err instanceof NeedItemError;
}
