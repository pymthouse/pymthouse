import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { authenticateAppClient, hasScope } from "@/lib/auth";
import { db } from "@/db/index";
import { appUsers, oidcClients } from "@/db/schema";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import { issueProgrammaticTokens, ProgrammaticTokenError } from "@/lib/oidc/programmatic-tokens";
import { getProviderApp } from "@/lib/provider-apps";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId } = await params;
  const correlationId = createCorrelationId();
  const client = await authenticateAppClient(request);

  if (!client) {
    return NextResponse.json(
      {
        error: "invalid_client",
        error_description: "failed confidential-client authentication",
        correlation_id: correlationId,
      },
      { status: 401 },
    );
  }

  if (client.appId !== clientId) {
    const app = await getProviderApp(clientId);
    await writeAuditLog({
      clientId: app?.id ?? null,
      action: "programmatic_token_issued",
      status: "forbidden",
      correlationId,
      metadata: { reason: "cross_app_request", callerAppId: client.appId },
    });
    return NextResponse.json(
      {
        error: "forbidden",
        error_description: "client_id does not match the requested app",
        correlation_id: correlationId,
      },
      { status: 403 },
    );
  }

  if (!hasScope(client.scopes, "users:token")) {
    return NextResponse.json(
      {
        error: "invalid_scope",
        error_description: "users:token scope is required for this client",
        correlation_id: correlationId,
      },
      { status: 403 },
    );
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

  const body = await request.json().catch(() => ({}));
  const requestedScopes = String(body.scope || "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  const scopes = requestedScopes.length > 0
    ? requestedScopes
    : ["sign:job"];

  const publicClientRows = await db
    .select({ allowedScopes: oidcClients.allowedScopes })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, client.appId))
    .limit(1);
  const publicAllowedScopes = publicClientRows[0]?.allowedScopes ?? "";
  const invalidScope = scopes.find(
    (scope) => !hasScope(publicAllowedScopes, scope) || scope === "admin",
  );
  if (invalidScope) {
    await writeAuditLog({
      clientId: app.id,
      action: "programmatic_token_issued",
      status: "invalid_scope",
      correlationId,
      metadata: { invalidScope },
    });
    return NextResponse.json(
      {
        error: "invalid_scope",
        error_description: "requested scope is not allowed for this client",
        correlation_id: correlationId,
      },
      { status: 400 },
    );
  }

  const appUserRows = await db
    .select()
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, app.id),
        eq(appUsers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  const appUser = appUserRows[0];

  if (!appUser || appUser.status !== "active") {
    await writeAuditLog({
      clientId: app.id,
      action: "programmatic_token_issued",
      status: "not_found",
      correlationId,
      metadata: { externalUserId },
    });
    return NextResponse.json(
      {
        error: "not_found",
        error_description: "the provisioned user could not be resolved",
        correlation_id: correlationId,
      },
      { status: 404 },
    );
  }

  let tokens;
  try {
    tokens = await issueProgrammaticTokens({
      developerAppId: app.id,
      oauthClientId: client.appId,
      appUserId: appUser.id,
      scopes,
    });
  } catch (err) {
    if (err instanceof ProgrammaticTokenError) {
      await writeAuditLog({
        clientId: app.id,
        action: "programmatic_token_issued",
        status: err.code,
        correlationId,
        metadata: { externalUserId, message: err.message },
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
    action: "programmatic_token_issued",
    status: "success",
    correlationId,
    metadata: {
      externalUserId,
      scopes,
      clientId: client.clientId,
    },
  });

  return NextResponse.json({ ...tokens, correlation_id: correlationId });
}
