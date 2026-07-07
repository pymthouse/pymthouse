import { NextRequest, NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit";
import {
  apiKeyOAuthError,
  authenticateApiKeyBearerRoute,
  isApiKeyRouteContext,
  parseApiKeyRouteJsonBody,
} from "@/lib/openapi/api-key-route-auth";
import { ApiKeySignerSessionRequestBodySchema } from "@/lib/openapi/schemas/credentials";
import {
  AppScopedSignerTokenExchangeError,
  GRANT_TYPE_TOKEN_EXCHANGE,
  handleAppScopedSignerTokenExchange,
  SUBJECT_ACCESS_TOKEN_TYPE,
} from "@/lib/oidc/app-scoped-signer-token-exchange";

const DEPRECATION_HEADERS = {
  Deprecation: "true",
  Link: '</api/v1/apps/{clientId}/oidc/token>; rel="successor-version"',
};

/**
 * Deprecated wrapper: Bearer pmth_* → SignerSession via app-scoped RFC 8693 exchange.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await authenticateApiKeyBearerRoute(request, clientId);
  if (!isApiKeyRouteContext(auth)) {
    return auth;
  }
  const { apiKey, app, correlationId } = auth;

  const body = await parseApiKeyRouteJsonBody(
    request,
    ApiKeySignerSessionRequestBodySchema,
    correlationId,
  );
  if (body instanceof NextResponse) {
    return body;
  }

  try {
    const session = await handleAppScopedSignerTokenExchange({
      publicClientId: clientId,
      clientId: "",
      clientSecret: "",
      grantType: GRANT_TYPE_TOKEN_EXCHANGE,
      subjectToken: apiKey,
      subjectTokenType: SUBJECT_ACCESS_TOKEN_TYPE,
      requestedTokenType: "",
      resource: "",
      audiences: [],
      correlationId,
    });

    await writeAuditLog({
      clientId: app.id,
      action: "api_key_signer_session_exchange",
      status: "success",
      correlationId,
    });

    return NextResponse.json(session, { headers: DEPRECATION_HEADERS });
  } catch (err) {
    if (err instanceof AppScopedSignerTokenExchangeError) {
      await writeAuditLog({
        clientId: app.id,
        action: "api_key_signer_session_exchange",
        status: err.code,
        correlationId,
      });
      return apiKeyOAuthError(correlationId, err.code, err.message, err.status);
    }
    throw err;
  }
}
