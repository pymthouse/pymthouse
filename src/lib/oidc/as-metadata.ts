/**
 * RFC 8414 Authorization Server Metadata for the PymtHouse OIDC AS.
 * Shared by `/.well-known/oauth-authorization-server/…` and discovery helpers.
 */

import { docsOidcUrl } from "@/lib/docs-base-url";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import { PROVIDER_ENDPOINT_PATHS } from "@/lib/oidc/routes";

export function buildAuthorizationServerMetadata(): Record<string, unknown> {
  const issuer = getIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.authorization}`,
    token_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.token}`,
    registration_endpoint: `${issuer}/reg`,
    jwks_uri: `${issuer}${PROVIDER_ENDPOINT_PATHS.jwks}`,
    revocation_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.revocation}`,
    introspection_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.introspection}`,
    userinfo_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.userinfo}`,
    device_authorization_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.deviceAuthorization}`,
    end_session_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.endSession}`,
    scopes_supported: [
      "openid",
      "profile",
      "email",
      "sign:job",
      "users:read",
      "users:write",
      "users:token",
      "admin",
      "offline_access",
    ],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "client_credentials",
      "urn:ietf:params:oauth:grant-type:device_code",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ],
    code_challenge_methods_supported: ["S256"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    service_documentation: docsOidcUrl(),
  };
}
