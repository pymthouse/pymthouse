import { NextResponse } from "next/server";
import { docsOidcUrl } from "@/platform/docs/base-url";
import { getIssuer } from "@/platform/oidc/issuer-urls";
import { PROVIDER_ENDPOINT_PATHS } from "@/platform/oidc/routes";

export async function GET(): Promise<NextResponse> {
  const issuer = getIssuer();

  const discovery = {
    issuer,
    authorization_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.authorization}`,
    token_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.token}`,
    userinfo_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.userinfo}`,
    jwks_uri: `${issuer}${PROVIDER_ENDPOINT_PATHS.jwks}`,
    device_authorization_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.deviceAuthorization}`,
    introspection_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.introspection}`,
    revocation_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.revocation}`,
    end_session_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.endSession}`,
    registration_endpoint: undefined, // Dynamic registration not supported
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
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ],
    claims_supported: [
      "iss",
      "sub",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "email",
      "name",
    ],
    code_challenge_methods_supported: ["S256"],
    service_documentation: docsOidcUrl(),
  };

  return NextResponse.json(discovery, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}
