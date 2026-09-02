/** MCP initialize instructions and tool copy. Loaded into the model client on every session. */

export const MCP_INSTRUCTIONS_LOCAL =
  "Botpasses holds named credentials. When a tool needs a secret, call request_grant. Do not wait for the operator to name Botpasses. Tools return names and grant status only. Secret values are injected into tool processes, never into this conversation. Never ask anyone to paste a secret here.";

export const MCP_INSTRUCTIONS_HOSTED = [
  "You can call third-party APIs (Spotify, Stripe, GitHub, and the rest) through Botpasses. The user does not need to say Botpasses or name a tool. You never see secret values.",
  "When the user wants data from an API, call http.request in the same turn. Do not list_items or find_items first. Do not ask which tool to use.",
  "Example: user says get my Spotify profile → http.request method GET path https://api.spotify.com/v1/me. Host can be api.spotify.com with path /v1/me. A full https path URL is enough.",
  "Botpasses finds the credential, asks the operator to grant if needed, and attaches it. Follow next.for_model. Retry with next.arguments when present.",
  "If the result has collect_url, tell the user to open that Botpasses page and enter the key there. Do not ask them to paste a secret into this chat. Then retry http.request.",
  "If the result has approval_code or grant status pending, tell them to approve in the Botpasses inbox. Then retry http.request with next.arguments.",
  "There is no get_secret. Never put a secret in a tool argument.",
  "A Client Secret is not a user access token. For Spotify token mint, POST https://accounts.spotify.com/api/token with item_name and optional client_id. Botpasses sends HTTP Basic and application/x-www-form-urlencoded. Then GET /v1/search works with the minted app token. GET /v1/me needs a user OAuth connect in the console, not client credentials.",
  "Prompt grants: if the origin returns 4xx, retry http.request with next.arguments. Do not ask for a new 8-digit code after a failed Spotify call.",
].join(" ");

export const HOSTED_TOOL_DESCRIPTIONS = {
  list_items:
    "Inventory of named vault items (names, last-4, environment). Do not call this first. Prefer http.request when the user wants an API called. Never returns values.",
  find_items:
    "Look up a stored credential by exact API hostname or item_name. Do not call this first. Prefer http.request (it finds for you). Use this when you only need to see names. Never returns values. On need_item, give the operator collect_url.",
  request_grant:
    "Ask the operator to allow this client to use a named item. Do not call this first. Prefer http.request, which requests a grant when inject is denied. Use this only if you already have an item_name and are not ready to call the API. Never returns the secret.",
  list_grants:
    "Check grant status for this client. Prefer retrying http.request after the operator approves. Names and status only.",
  "http.request":
    "Primary tool. Call this in the same turn the user asks for Spotify, Stripe, GitHub, or any allowlisted API. Pass host (api.spotify.com) or item_name, method, and path. path may be /v1/search or a full https URL. For a Spotify Client Secret, pass client_id (public) and call accounts.spotify.com/api/token or api.spotify.com/v1/search — Botpasses mints an app token (Basic + form body), never Bearer of the secret. GET /v1/me needs a user connect. Do not list_items first. Do not ask the user for a token. Returns a redacted body, or collect_url / pending grant with next.for_model and next.arguments to retry. Never returns the secret.",
} as const;

export const HOSTED_TOOL_PARAM_DESCRIPTIONS = {
  find_host:
    "Hostname of the API you need to call, exactly as in HTTPS (for example api.spotify.com). Not a URL. Prefer this over guessing an item name.",
  find_item_name: "Exact stored credential name, if the user or a prior find_items result named one.",
  find_task_description: "Short reason shown to the operator in the Botpasses inbox.",
  grant_item_name: "Exact item name from find_items.",
  grant_task_description: "Short reason shown to the operator when they approve.",
  http_item_name: "Exact item name if you already have one. Optional when host or a full URL path is set.",
  http_host:
    "API hostname (api.spotify.com). Optional when item_name is set or path is a full https URL.",
  http_path:
    "Path on the allowlisted origin (/v1/me) or a full https URL (https://api.spotify.com/v1/me). Host is taken from the URL when you pass one. Example for Spotify profile: https://api.spotify.com/v1/me.",
  http_method: "HTTPS method for the API call.",
  http_body:
    "Object body for POST, PUT, or PATCH. JSON by default. For Spotify /api/token use content_type application/x-www-form-urlencoded (or omit — Botpasses form-encodes that path). Omit for GET.",
  http_content_type:
    "application/json (default) or application/x-www-form-urlencoded. Required for OAuth token endpoints.",
  http_client_id:
    "Public OAuth Client ID when the vault item is a Client Secret. Never the Client Secret. Used for HTTP Basic on accounts.spotify.com and to mint an app token for api.spotify.com.",
} as const;
