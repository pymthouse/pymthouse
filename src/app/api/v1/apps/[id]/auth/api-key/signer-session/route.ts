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
  ApiKeySignerSessionError,
  mintSignerSessionFromAppApiKey,
} from "@/lib/oidc/api-key-signer-session";

/**
 * Canonical single-call exchange: pmth_* API key → SignerSession (signer JWT).
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
    const session = await mintSignerSessionFromAppApiKey({
      apiKey,
      publicClientId: clientId,
      scope: body.scope,
    });

    await writeAuditLog({
      clientId: app.id,
      action: "api_key_signer_session_exchange",
      status: "success",
      correlationId,
    });

    return NextResponse.json({
      ...session,
      correlation_id: correlationId,
    });
  } catch (err) {
    if (err instanceof ApiKeySignerSessionError) {
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
