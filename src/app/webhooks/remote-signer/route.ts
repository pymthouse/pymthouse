import { getIssuer, getOidcJwksUrl } from "@/lib/oidc/issuer-urls";
import { handleAuthorize } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createLegacyWebhookConfigFromEnv } from "@pymthouse/clearinghouse-identity-webhook/legacy-env";

function buildWebhookConfig() {
  const jwtIssuer = process.env.JWT_ISSUER?.trim() || getIssuer();
  // identity-webhook defaults to {issuer}/.well-known/jwks.json; pymthouse serves {issuer}/jwks.
  const jwksUri =
    process.env.OIDC_JWKS_URI?.trim() ||
    process.env.JWKS_URI?.trim() ||
    getOidcJwksUrl();
  return createLegacyWebhookConfigFromEnv(
    {
      ...process.env,
      OIDC_JWKS_URI: jwksUri,
    },
    { jwtIssuer },
  );
}

export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || "";
  if (!webhookSecret) {
    return Response.json(
      { status: 500, reason: "server misconfiguration" },
      { status: 500 },
    );
  }

  return handleAuthorize(request, buildWebhookConfig());
}
