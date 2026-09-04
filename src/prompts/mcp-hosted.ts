/** MCP initialize instructions and tool copy. Loaded into the model client on every session. */

export const MCP_INSTRUCTIONS_LOCAL = [
  "Botpasses holds named credentials on this machine. You never see secret values.",
  "When the user wants data from an API, call http_request in the same turn with host (or item_name), method, and path. Do not wait for the operator to name Botpasses. Do not list_items first.",
  "Botpasses finds the credential and attaches it. If the result is need_item, tell the operator to run the vault set command in the message. If the result has status pending, tell them to approve with the vault grant command in the message (or the local console), then retry http_request with retry.",
  "Tools return names, last-4, and grant status only. Secret values are injected into tool processes, never into this conversation. There is no get_secret. Never ask anyone to paste a secret here.",
].join(" ");

export const MCP_INSTRUCTIONS_HOSTED = [
  "You can call third-party APIs through Botpasses. The user does not need to say Botpasses or name a tool. You never see secret values.",
  "When the user wants data from an API, call http_request in the same turn. Do not list_items or find_items first. Do not ask which tool to use.",
  "Example: user asks for their profile on an API → http_request method GET path https://api.example.com/v1/me. Host can be api.example.com with path /v1/me. A full https path URL is enough.",
  "Botpasses finds the credential, asks the operator to grant if needed, and attaches it. Follow next.for_model. Retry with next.arguments when present.",
  "If the result has collect_url, tell the user to open that Botpasses page and enter the key there. Do not ask them to paste a secret into this chat. Then retry http_request.",
  "If the result has approval_code or grant status pending, tell them to approve in the Botpasses inbox. Then retry http_request with next.arguments.",
  "There is no get_secret. Never put a secret in a tool argument.",
  "Botpasses mints and refreshes OAuth tokens for known providers (Spotify, GitHub, Google, Slack, Stripe); pass client_id when the credential is an OAuth client secret.",
  "Results carry origin_status (the API's HTTP status), a redacted body, and origin_headers (content-type, link, retry-after, rate-limit headers). Pass dry_run true to learn which item and approval a call would use without sending it.",
  "On 4xx, fix the path, query, or body and retry http_request with next.arguments; on 5xx retry once. A one-call approval is spent by any answer from the API; if the retry returns a pending grant, tell the user to approve it. A one-call approval comes back only when the request never left Botpasses (DNS, connect, or TLS failure).",
].join(" ");

export const HOSTED_TOOL_DESCRIPTIONS = {
  list_items:
    "Inventory of named vault items (names, last-4, environment). Do not call this first. Prefer http_request when the user wants an API called. Never returns values.",
  find_items:
    "Look up a stored credential by exact API hostname or item_name. Do not call this first. Prefer http_request (it finds for you). Use this when you only need to see names. Never returns values. On need_item, give the operator collect_url.",
  request_grant:
    "Ask the operator to allow this client to use a named item. Do not call this first. Prefer http_request, which requests a grant when inject is denied. Use this only if you already have an item_name and are not ready to call the API. Never returns the secret.",
  list_grants:
    "Check grant status for this client. Prefer retrying http_request after the operator approves. Names and status only.",
  http_request:
    "Primary tool. Call this in the same turn the user asks for any allowlisted API. Pass host or item_name, method, and path. path may be /v1/me or a full https URL. Botpasses attaches the credential in the mode the operator stored (Bearer, Basic, header, query, cookie, HMAC signature, AWS SigV4) and mints or refreshes OAuth tokens for known providers; pass client_id when the item is an OAuth client secret. Optional timeout_ms (1000 to 30000, default 10000) and dry_run (explain which item and approval would be used without sending). Do not list_items first. Do not ask the user for a token. Returns origin_status, a redacted body, origin_headers, or collect_url / pending grant with next.for_model and next.arguments to retry. Never returns the secret.",
} as const;

export const HOSTED_TOOL_PARAM_DESCRIPTIONS = {
  find_host:
    "Hostname of the API you need to call, exactly as in HTTPS (for example api.example.com). Not a URL. Prefer this over guessing an item name.",
  find_item_name: "Exact stored credential name, if the user or a prior find_items result named one.",
  find_task_description: "Short reason shown to the operator in the Botpasses inbox.",
  grant_item_name: "Exact item name from find_items.",
  grant_task_description: "Short reason shown to the operator when they approve.",
  http_item_name: "Exact item name if you already have one. Optional when host or a full URL path is set.",
  http_host:
    "API hostname (api.example.com). Optional when item_name is set or path is a full https URL.",
  http_path:
    "Path on the allowlisted origin (/v1/me) or a full https URL (https://api.example.com/v1/me). Host is taken from the URL when you pass one.",
  http_method: "HTTPS method for the API call.",
  http_body:
    "Object body for POST, PUT, or PATCH. JSON by default. OAuth token endpoints of known providers are form-encoded automatically. Omit for GET.",
  http_content_type:
    "application/json (default) or application/x-www-form-urlencoded. Required for OAuth token endpoints of unknown providers.",
  http_client_id:
    "Public OAuth Client ID when the vault item is an OAuth client secret. Never the Client Secret. Botpasses uses it to mint an app token at the provider token endpoint.",
  http_timeout_ms:
    "Origin deadline in milliseconds, 1000 to 30000 (default 10000). Values outside the range are clamped.",
  http_dry_run:
    "When true, Botpasses resolves the item and approval and reports would_send, reason, grant_status, inject_mode, and provider without calling the API or using an approval.",
} as const;
