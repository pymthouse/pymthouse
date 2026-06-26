import { NextRequest, NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit";
import { resolveActiveAppApiKey } from "@/lib/app-api-keys";
import {
  apiKeyOAuthError,
  authenticateApiKeyBearerRoute,
  isApiKeyRouteContext,
  parseApiKeyRouteJsonBody,
} from "@/lib/openapi/api-key-route-auth";
import { parseScopeList } from "@/lib/openapi/api-key";
import { ApiKeyTokenRequestBodySchema } from "@/lib/openapi/schemas/credentials";
import {
  issueProgrammaticTokens,
  ProgrammaticTokenError,
} from "@/lib/oidc/programmatic-tokens";

/**
 * Exchange a long-lived dashboard API key (Bearer pmth_*) for short-lived user JWTs.
 * Intended for SDK / CLI use before RFC 8693 signer session exchange.
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

  const resolved = await resolveActiveAppApiKey(apiKey, clientId);
  if (!resolved || resolved.developerAppId !== app.id) {
    await writeAuditLog({
      clientId: app.id,
      action: "api_key_token_exchange",
      status: "unauthorized",
      correlationId,
    });
    return apiKeyOAuthError(
      correlationId,
      "invalid_client",
      "invalid or revoked API key",
      401,
    );
  }

  const body = await parseApiKeyRouteJsonBody(
    request,
    ApiKeyTokenRequestBodySchema,
    correlationId,
  );
  if (body instanceof NextResponse) {
    return body;
  }

  const scopes = parseScopeList(body.scope);

  let tokens;
  try {
    tokens = await issueProgrammaticTokens({
      developerAppId: resolved.developerAppId,
      oauthClientId: resolved.publicClientId,
      appUserId: resolved.appUserId,
      scopes,
    });
  } catch (err) {
    if (err instanceof ProgrammaticTokenError) {
      await writeAuditLog({
        clientId: app.id,
        action: "api_key_token_exchange",
        status: err.code,
        correlationId,
        metadata: {
          externalUserId: resolved.externalUserId,
          message: err.message,
        },
      });
      return apiKeyOAuthError(correlationId, err.code, err.message, 400);
    }
    throw err;
  }

  await writeAuditLog({
    clientId: app.id,
    action: "api_key_token_exchange",
    status: "success",
    correlationId,
    metadata: {
      keyId: resolved.apiKeyId,
      externalUserId: resolved.externalUserId,
      scopes,
    },
  });

  return NextResponse.json({
    ...tokens,
    externalUserId: resolved.externalUserId,
    correlation_id: correlationId,
  });
}
