import { NextResponse } from "next/server";
import { docsOidcUrl } from "@/lib/docs-base-url";
import { buildAuthorizationServerMetadata } from "@/lib/oidc/as-metadata";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import { PROVIDER_ENDPOINT_PATHS } from "@/lib/oidc/routes";

export async function GET(): Promise<NextResponse> {
  const issuer = getIssuer();
  const as = buildAuthorizationServerMetadata();

  const discovery = {
    ...as,
    registration_endpoint: `${issuer}/reg`,
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
      "pymthouse_app",
    ],
    code_challenge_methods_supported: ["S256"],
    service_documentation: docsOidcUrl(),
    authorization_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.authorization}`,
    token_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.token}`,
    userinfo_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.userinfo}`,
    jwks_uri: `${issuer}${PROVIDER_ENDPOINT_PATHS.jwks}`,
    device_authorization_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.deviceAuthorization}`,
    introspection_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.introspection}`,
    revocation_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.revocation}`,
    end_session_endpoint: `${issuer}${PROVIDER_ENDPOINT_PATHS.endSession}`,
  };

  return NextResponse.json(discovery, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}
