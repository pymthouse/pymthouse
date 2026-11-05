import type { NextRequest } from "next/server";
import { authenticateAppClient } from "@/domains/identity-access/runtime/request-auth";
import {
  createCorrelationId,
  writeAuditLog,
} from "@/domains/identity-access/runtime/audit";
import {
  issueProgrammaticTokens,
  ProgrammaticTokenError,
} from "@/domains/oidc-platform/runtime/programmatic-tokens";
import { getProviderApp } from "../repo/provider-access";
import {
  getActiveAppUserByExternalUserId,
  getPublicAllowedScopesForClient,
} from "../repo/app-user-tokens";
import {
  parseRequestedProgrammaticScopes,
  validateProgrammaticScopes,
  validateProgrammaticTokenRequest,
} from "../service/app-user-tokens";

export async function issueAppUserProgrammaticToken(params: {
  request: NextRequest;
  clientId: string;
  externalUserId: string;
}): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 401 | 403 | 404; body: Record<string, unknown> }
> {
  const correlationId = createCorrelationId();
  const client = await authenticateAppClient(params.request);

  const requestValidation = validateProgrammaticTokenRequest({
    authenticatedClient: client,
    requestedClientId: params.clientId,
    correlationId,
  });
  if (!requestValidation.ok) {
    if (client && client.appId !== params.clientId) {
      const crossApp = await getProviderApp(params.clientId);
      await writeAuditLog({
        clientId: crossApp?.id ?? null,
        action: "programmatic_token_issued",
        status: "forbidden",
        correlationId,
        metadata: { reason: "cross_app_request", callerAppId: client.appId },
      });
    }
    return requestValidation;
  }

  const app = await getProviderApp(params.clientId);
  if (!app) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "not_found",
        error_description: "developer app was not found for this client_id",
        correlation_id: correlationId,
      },
    };
  }

  const requestedScopes = parseRequestedProgrammaticScopes(
    await params.request.json().catch(() => ({})),
  );
  const publicAllowedScopes = await getPublicAllowedScopesForClient(client!.appId);
  const scopeValidation = validateProgrammaticScopes({
    requestedScopes,
    publicAllowedScopes,
    correlationId,
  });
  if (!scopeValidation.ok) {
    await writeAuditLog({
      clientId: app.id,
      action: "programmatic_token_issued",
      status: "invalid_scope",
      correlationId,
      metadata: {
        invalidScope: requestedScopes.find(
          (scope) => !publicAllowedScopes || !publicAllowedScopes.split(/[,\s]+/).includes(scope),
        ),
      },
    });
    return scopeValidation;
  }

  const appUser = await getActiveAppUserByExternalUserId(app.id, params.externalUserId);
  if (!appUser) {
    await writeAuditLog({
      clientId: app.id,
      action: "programmatic_token_issued",
      status: "not_found",
      correlationId,
      metadata: { externalUserId: params.externalUserId },
    });
    return {
      ok: false,
      status: 404,
      body: {
        error: "not_found",
        error_description: "the provisioned user could not be resolved",
        correlation_id: correlationId,
      },
    };
  }

  try {
    const tokens = await issueProgrammaticTokens({
      developerAppId: app.id,
      oauthClientId: client!.appId,
      appUserId: appUser.id,
      scopes: requestedScopes,
    });

    await writeAuditLog({
      clientId: app.id,
      action: "programmatic_token_issued",
      status: "success",
      correlationId,
      metadata: {
        externalUserId: params.externalUserId,
        scopes: requestedScopes,
        clientId: client!.clientId,
      },
    });

    return { ok: true, body: { ...tokens, correlation_id: correlationId } };
  } catch (err) {
    if (err instanceof ProgrammaticTokenError) {
      await writeAuditLog({
        clientId: app.id,
        action: "programmatic_token_issued",
        status: err.code,
        correlationId,
        metadata: { externalUserId: params.externalUserId, message: err.message },
      });
      return {
        ok: false,
        status: 400,
        body: {
          error: err.code,
          error_description: err.message,
          correlation_id: correlationId,
        },
      };
    }
    throw err;
  }
}
