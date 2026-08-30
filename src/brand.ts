/** Product identity. Process env prefix stays VAULT_*. */

export const PRODUCT_NAME = "Botpasses";
export const PRODUCT_SLUG = "botpasses";
export const MCP_SERVER_NAME = "botpasses";
export const HEALTH_PRODUCT = "botpasses";
export const DEFAULT_HOME_DIRNAME = ".botpasses";
export const STAGING_ORIGIN = "https://staging.botpasses.ai";
export const PRODUCTION_ORIGIN = "https://botpasses.ai";
export const WWW_AUTHENTICATE_REALM = "botpasses";

export const MCP_INSTRUCTIONS_LOCAL =
  "Botpasses. Tools return names and grant status only. Secret values are injected into tool processes, never into this conversation.";

export const MCP_INSTRUCTIONS_HOSTED =
  "Botpasses. Tools return names and grant status only. Secret values are injected into allowlisted origins via http.request, never into this conversation.";
