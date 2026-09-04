/** RFC 8414 / RFC 9728 documents MCP clients parse. One builder, many URLs. */

export type AuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  registration_endpoint: string;
  device_authorization_endpoint: string;
  revocation_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  /** OpenID Connect Discovery 1.0 required fields; the same document is served at openid-configuration. */
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  authorization_response_iss_parameter_supported: boolean;
  /** OAuth Client ID Metadata Document (draft-02): `client_id` may be an https URL. */
  client_id_metadata_document_supported: boolean;
  resource: string;
  resource_metadata: string;
};

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
};

export function publicOrigin(publicUrl: string): string {
  return publicUrl.replace(/\/$/, "");
}

export function mcpResource(origin: string): string {
  return `${origin.replace(/\/$/, "")}/mcp`;
}

export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/.well-known/oauth-protected-resource/mcp`;
}

export function authorizationServerMetadata(publicUrl: string): AuthorizationServerMetadata {
  const origin = publicOrigin(publicUrl);
  const resource = mcpResource(origin);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    jwks_uri: `${origin}/oauth/jwks`,
    registration_endpoint: `${origin}/oauth/register`,
    device_authorization_endpoint: `${origin}/oauth/device/auth`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: ["openid", "mcp"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    resource,
    resource_metadata: protectedResourceMetadataUrl(origin),
  };
}

export function protectedResourceMetadata(publicUrl: string): ProtectedResourceMetadata {
  const origin = publicOrigin(publicUrl);
  return {
    resource: mcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: ["openid", "mcp"],
    bearer_methods_supported: ["header"],
  };
}

export function mcpWwwAuthenticate(publicUrl: string, realm: string): string {
  const metadata = protectedResourceMetadataUrl(publicUrl);
  return `Bearer realm="${realm}", resource_metadata="${metadata}"`;
}

const PRM_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/mcp/.well-known/oauth-protected-resource",
]);

const AS_PATHS = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/mcp/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/mcp/.well-known/openid-configuration",
]);

export function isOauthDiscoveryPath(path: string): boolean {
  return PRM_PATHS.has(path) || AS_PATHS.has(path);
}

export function oauthDiscoveryDocument(
  path: string,
  publicUrl: string,
): AuthorizationServerMetadata | ProtectedResourceMetadata | undefined {
  if (PRM_PATHS.has(path)) return protectedResourceMetadata(publicUrl);
  if (AS_PATHS.has(path)) return authorizationServerMetadata(publicUrl);
  return undefined;
}

/** Browser MCP hosts (Grok, Claude) are not this origin. Operator /api stays locked. */
export function isMcpClientSurface(path: string): boolean {
  return (
    isOauthDiscoveryPath(path) ||
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path.startsWith("/oauth/")
  );
}
