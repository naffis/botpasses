/** Structured next-step on MCP results. Steers the model without a user-pasted procedure. */
import { BODY_TOO_LARGE, RAW_RESPONSE_CAP } from "./connector.ts";

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

/** The `error` code of a connector-made JSON body (`body_too_large`), or undefined for an origin body. */
function connectorErrorCode(body: unknown): string | undefined {
  if (typeof body !== "string" || !body.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

function withRetryArgs(next: McpNext, payload: PublicRecord): McpNext {
  const retry = stringMap(payload.retry);
  if (!retry) return next;
  const args: Record<string, string> = { ...next.arguments };
  for (const [key, value] of Object.entries(retry)) {
    if (next.tool === "http_request" && key === "provider") continue;
    args[key] = value;
  }
  return Object.keys(args).length > 0 ? { ...next, arguments: args } : next;
}

/** Brief note when the connector rewrote a playlist `/tracks` path to `/items`. Names no vendor. */
function rewriteNote(payload: PublicRecord): string {
  if (payload.path_rewritten !== true) return "";
  const from = typeof payload.requested_path === "string" ? payload.requested_path : "";
  const to = typeof payload.rewritten_path === "string" ? payload.rewritten_path : "";
  if (!from || !to) return "";
  const body =
    payload.body_key_mapped === "tracks->items" ? " The DELETE body key tracks was mapped to items." : "";
  return ` The origin path was rewritten from ${from} to ${to}.${body}`;
}

function recipeHint(payload: PublicRecord): string {
  const recipe = isRecord(payload.recipe) ? payload.recipe : undefined;
  const hint = recipe && typeof recipe.hint === "string" ? recipe.hint.trim() : "";
  return hint ? ` ${hint}` : "";
}

function isSetupResult(payload: PublicRecord): boolean {
  return Array.isArray(payload.steps);
}

function nextBase(payload: PublicRecord): McpNext | undefined {
  const status = payload.status;
  if (status === "need_item") {
    const hint = recipeHint(payload);
    if (isSetupResult(payload)) {
      if (typeof payload.collect_url === "string" && payload.collect_url.length > 0) {
        return {
          for_model:
            `Tell the user to open collect_url in a browser and enter the credential on Botpasses.${hint} Do not ask them to paste the secret here. After they confirm it is stored, call setup again with the same provider or host.`,
          tool: "setup",
        };
      }
      return {
        for_model:
          `This credential is not stored yet.${hint} Call setup again without dry_run to get a collect_url, or give the user the vault set command in the message. Do not ask them to paste a secret.`,
        tool: "setup",
      };
    }
    return {
      for_model:
        `Tell the user to open collect_url in a browser and enter the credential on Botpasses.${hint} Do not ask them to paste the secret here. After they confirm it is stored, call http_request again with next.arguments (same host, method, and path).`,
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
    if (isSetupResult(payload)) {
      return {
        for_model:
          "Multiple credentials match those hosts. Pick one item_name from items and call http_request with that name, method, and path. Do not ask the user for a token.",
        tool: "http_request",
      };
    }
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
  if (status === "user_connect_required") {
    if (isSetupResult(payload)) {
      return {
        for_model:
          "The app credential is stored. Give the user connect_url (a Botpasses console link) and ask them to connect their account there; the dialog also allows this agent to use it. Do not retry until they confirm the connect. Then call setup again with the same provider or host. Do not ask for a token.",
        tool: "setup",
      };
    }
    return {
      for_model:
        "This API path answers only for a connected user account, and Botpasses holds only the app credential. Nothing was sent and no approval was spent. Give the user connect_url (a Botpasses console link) and ask them to connect their account there; the dialog also allows this agent to use it. Do not retry until they confirm the connect. Then call http_request once with next.arguments. Do not ask for a token.",
      tool: "http_request",
    };
  }
  if (status === "ready") {
    return {
      for_model:
        "Setup is complete. Call http_request with next.arguments. Botpasses attaches the credential. Do not ask the user for a token.",
      tool: "http_request",
    };
  }
  if (status === "ready_prompt") {
    return {
      for_model:
        "The credential is stored. Ask the operator to click Always-allow on this grant in the Botpasses Inbox so this agent can keep using it. Do not invent a second Collect URL. You may call http_request after they approve, or wait for Always-allow then call http_request with next.arguments.",
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
          `${hint || "The origin rejected the credential or the resource is gone."} Retry http_request with next.arguments. A standing or session approval still covers the retry; a one-call approval was spent by this answer, so if the retry returns a pending grant, tell the user to approve it. Do not ask for a token.`,
        tool: "http_request",
      };
    }
    if (originStatus === 502 && connectorErrorCode(payload.body) === BODY_TOO_LARGE) {
      // Not transient: the same call gets the same oversized answer and spends another approval.
      return {
        for_model:
          `The API answered, but its response was larger than ${RAW_RESPONSE_CAP / (1024 * 1024)} MiB and was discarded. Do not retry the same call. Narrow it first (pagination, a smaller limit or page size, a fields filter), then call http_request with the narrowed arguments. A one-call approval was spent by this answer; if the retry returns a pending grant, tell the user to approve it.`,
        tool: "http_request",
      };
    }
    if (originStatus >= 500) {
      return {
        for_model:
          "Transient origin error; retry once. Use http_request with next.arguments. A standing or session approval still covers the retry; if the retry returns a pending grant, tell the user to approve it.",
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
  const note = rewriteNote(payload);
  const withNote = note ? { ...next, for_model: `${next.for_model}${note}` } : next;
  return withRetryArgs(withNote, payload);
}

export function attachMcpNext(payload: unknown): unknown {
  const next = nextForPayload(payload);
  if (!next || !isRecord(payload)) return payload;
  return { ...payload, next };
}
