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
        "Tell the user to open collect_url in a browser and enter the credential on Botpasses. Do not ask them to paste the secret here. After they confirm it is stored, call http.request again with next.arguments (same host, method, and path).",
      tool: "http.request",
    };
  }
  if (status === "found") {
    const item = isRecord(payload.item) && typeof payload.item.name === "string" ? payload.item.name : "";
    return {
      for_model:
        "Call http.request with this item_name plus method and path (for example GET /v1/me). Botpasses attaches the credential. Do not ask the user for a token.",
      tool: "http.request",
      arguments: item ? { item_name: item } : undefined,
    };
  }
  if (status === "ambiguous") {
    return {
      for_model:
        "Multiple credentials match. Pick one item_name from items and call http.request with that name, method, and path. Do not ask the user for a token.",
    };
  }
  if (status === "host_mismatch") {
    return {
      for_model:
        "This item is not allowlisted for that host. Call find_items with host only, or http.request with host, method, and path.",
      tool: "find_items",
    };
  }
  if (typeof payload.grant_id === "string" && status === "pending") {
    return {
      for_model:
        "Tell the user to approve in the Botpasses inbox or with the 8-digit approval_code. Then call http.request again with next.arguments. Do not ask for a token.",
      tool: "http.request",
    };
  }
  if (typeof payload.grant_id === "string" && status === "active") {
    const name = typeof payload.item_name === "string" ? payload.item_name : undefined;
    return {
      for_model: "Grant is active. Call http.request with next.arguments (item_name, method, and path).",
      tool: "http.request",
      arguments: name ? { item_name: name } : undefined,
    };
  }
  if (typeof status === "number" && "body" in payload) {
    if (status === 401 || status === 410) {
      const hint = typeof payload.hint === "string" ? payload.hint : "";
      return {
        for_model:
          `${hint || "The origin rejected this call."} Retry http.request with next.arguments. The same Botpasses approval is still valid. Do not ask for a new 8-digit code. Do not ask for a token. A Client Secret is not a user access token. GET /v1/me needs a Spotify user connect in the console.`,
        tool: "http.request",
      };
    }
    if (status >= 400) {
      return {
        for_model:
          "The origin returned an error. Retry http.request with next.arguments. Do not ask for a new approval code or a token.",
        tool: "http.request",
      };
    }
    return {
      for_model:
        "Answer the user from this redacted API body. Do not claim you have the secret. Do not ask them to paste a key. access_token values are redacted.",
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
