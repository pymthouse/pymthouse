import { NextRequest, NextResponse } from "next/server";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import {
  ApiKeyCredentialError,
  parseAppApiKeyBearer,
  parseScopeList,
} from "@/lib/openapi/api-key";
import { ApiKeySignerSessionRequestBodySchema } from "@/lib/openapi/schemas/credentials";
import {
  ApiKeySignerSessionError,
  mintSignerSessionFromAppApiKey,
} from "@/lib/oidc/api-key-signer-session";
import { getProviderApp } from "@/lib/provider-apps";

/**
 * Canonical single-call exchange: pmth_* API key → SignerSession (signer JWT).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const correlationId = createCorrelationId();

  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Authorization Bearer API key is required",
        correlation_id: correlationId,
      },
      { status: 401 },
    );
  }

  let apiKey: string;
  try {
    apiKey = parseAppApiKeyBearer(authHeader.slice(7).trim());
  } catch (err) {
    if (err instanceof ApiKeyCredentialError) {
      return NextResponse.json(
        {
          error: err.code,
          error_description: err.message,
          correlation_id: correlationId,
        },
        { status: err.status },
      );
    }
    throw err;
  }

  const app = await getProviderApp(clientId);
  if (!app) {
    return NextResponse.json(
      {
        error: "not_found",
        error_description: "developer app was not found for this client_id",
        correlation_id: correlationId,
      },
      { status: 404 },
    );
  }

  const rawBody = await request.json().catch(() => ({}));
  const parsedBody = ApiKeySignerSessionRequestBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: parsedBody.error.issues[0]?.message ?? "Invalid request body",
        correlation_id: correlationId,
      },
      { status: 400 },
    );
  }

  try {
    const session = await mintSignerSessionFromAppApiKey({
      apiKey,
      publicClientId: clientId,
      scope: parsedBody.data.scope,
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
      return NextResponse.json(
        {
          error: err.code,
          error_description: err.message,
          correlation_id: correlationId,
        },
        { status: err.status },
      );
    }
    throw err;
  }
}
