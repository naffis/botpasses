/** Structured next-step on MCP results. Steers the model without a user-pasted procedure. */

export type McpNext = {
  for_model: string;
  tool?: string;
  arguments?: Record<string, string>;
};

type PublicRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PublicRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function withRetryArgs(next: McpNext, payload: PublicRecord): McpNext {
  const retry = stringMap(payload.retry);
  if (!retry) return next;
  return { ...next, arguments: { ...next.arguments, ...retry } };
}

function nextBase(payload: PublicRecord): McpNext | undefined {
  const status = payload.status;
  if (status === "need_item") {
    return {
      for_model:
        "Tell the user to open collect_url in a browser and enter the credential on Botpasses. Do not ask them to paste the secret here. After they confirm it is stored, call http_request again with next.arguments (same host, method, and path).",
      tool: "http_request",
    };
  }
  if (status === "found") {
    const item = isRecord(payload.item) && typeof payload.item.name === "string" ? payload.item.name : "";
    return {
      for_model:
        "Call http_request with this item_name plus method and path (for example GET /v1/me). Botpasses attaches the credential. Do not ask the user for a token.",
      tool: "http_request",
      arguments: item ? { item_name: item } : undefined,
    };
  }
  if (status === "ambiguous") {
    return {
      for_model:
        "Multiple credentials match. Pick one item_name from items and call http_request with that name, method, and path. Do not ask the user for a token.",
    };
  }
  if (status === "host_mismatch") {
    return {
      for_model:
        "This item is not allowlisted for that host. Call http_request with the host, method, and path of the API you need; Botpasses picks the matching credential.",
      tool: "http_request",
    };
  }
  if (status === "scope_denied") {
    return {
      for_model:
        "The current approval does not cover this method, host, or path. Call request_grant with item_name, host, method, and path for this call, then retry http_request after the operator approves.",
      tool: "request_grant",
    };
  }
  if (typeof payload.grant_id === "string" && status === "pending") {
    return {
      for_model:
        "Tell the user to approve in the Botpasses inbox or with the 8-digit approval_code. Then call http_request again with next.arguments. Do not ask for a token.",
      tool: "http_request",
    };
  }
  if (typeof payload.grant_id === "string" && status === "active") {
    const name = typeof payload.item_name === "string" ? payload.item_name : undefined;
    return {
      for_model: "Grant is active. Call http_request with next.arguments (item_name, method, and path).",
      tool: "http_request",
      arguments: name ? { item_name: name } : undefined,
    };
  }
  if (payload.dry_run === true) {
    return {
      for_model:
        payload.would_send === true
          ? "Dry run only: nothing was sent and no approval was used. Call http_request again without dry_run to make the request."
          : `Dry run only: the request would not be sent (reason: ${String(payload.reason)}). Fix the item_name, host, or approval first. Nothing was sent.`,
      tool: "http_request",
    };
  }
  // Origin results carry the HTTP status as `origin_status` (`status` is a deprecated duplicate).
  const originStatus = payload.origin_status;
  if (typeof originStatus === "number" && "body" in payload) {
    if (originStatus === 401 || originStatus === 410) {
      const hint = typeof payload.hint === "string" ? payload.hint : "";
      return {
        for_model:
          `${hint || "The origin rejected the credential or the resource is gone."} Retry http_request with next.arguments. The same Botpasses approval is still valid. Do not ask for a new 8-digit code. Do not ask for a token.`,
        tool: "http_request",
      };
    }
    if (originStatus >= 500) {
      return {
        for_model:
          "Transient origin error; retry once. Use http_request with next.arguments. The same approval is still valid.",
        tool: "http_request",
      };
    }
    if (originStatus >= 400) {
      return {
        for_model:
          "The request was rejected by the API; change the path, query, or body before retrying. Do not ask for a new approval.",
        tool: "http_request",
      };
    }
    return {
      for_model:
        "Answer the user from this redacted API body. Do not claim you have the secret. Do not ask them to paste a key. access_token values are redacted. origin_headers carries pagination (link) and rate-limit headers when the API sent them.",
    };
  }
  return undefined;
}

export function nextForPayload(payload: unknown): McpNext | undefined {
  if (!isRecord(payload)) return undefined;
  const next = nextBase(payload);
  if (!next) return undefined;
  return withRetryArgs(next, payload);
}

export function attachMcpNext(payload: unknown): unknown {
  const next = nextForPayload(payload);
  if (!next || !isRecord(payload)) return payload;
  return { ...payload, next };
}
