import { NextRequest, NextResponse } from "next/server";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import { resolveActiveAppApiKey } from "@/lib/app-api-keys";
import { getProviderApp } from "@/lib/provider-apps";
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

  const apiKey = authHeader.slice(7).trim();
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

  const resolved = await resolveActiveAppApiKey(apiKey, clientId);
  if (!resolved || resolved.developerAppId !== app.id) {
    await writeAuditLog({
      clientId: app.id,
      action: "api_key_token_exchange",
      status: "unauthorized",
      correlationId,
    });
    return NextResponse.json(
      {
        error: "invalid_client",
        error_description: "invalid or revoked API key",
        correlation_id: correlationId,
      },
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const requestedScopes = String(body.scope || "sign:job")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const scopes = requestedScopes.length > 0 ? requestedScopes : ["sign:job"];

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
      return NextResponse.json(
        {
          error: err.code,
          error_description: err.message,
          correlation_id: correlationId,
        },
        { status: 400 },
      );
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
