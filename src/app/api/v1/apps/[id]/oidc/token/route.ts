import { NextRequest, NextResponse } from "next/server";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import {
  AppScopedSignerTokenExchangeError,
  handleAppScopedSignerTokenExchange,
} from "@/lib/oidc/app-scoped-signer-token-exchange";
import { clientCredentialsFromTokenRequest } from "@/lib/oidc/token-request-client-credentials";
import { getProviderApp } from "@/lib/provider-apps";

function tokenExchangeErrorResponse(
  err: AppScopedSignerTokenExchangeError,
  correlationId: string,
): NextResponse {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  };
  if (err.status === 401 && err.code === "invalid_client") {
    headers["WWW-Authenticate"] = 'Basic realm="token"';
  }
  return NextResponse.json(
    {
      error: err.code,
      error_description: err.message,
      correlation_id: correlationId,
    },
    { status: err.status, headers },
  );
}

/**
 * RFC 8693 signer session token exchange (clearinghouse-compatible).
 * POST /api/v1/apps/{clientId}/oidc/token
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = createCorrelationId();
  const { id: clientId } = await params;

  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "content-type must be application/x-www-form-urlencoded",
        correlation_id: correlationId,
      },
      {
        status: 400,
        headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
      },
    );
  }

  let form: URLSearchParams;
  try {
    const raw = await request.text();
    form = new URLSearchParams(raw);
  } catch {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "unable to read request body",
        correlation_id: correlationId,
      },
      { status: 400 },
    );
  }

  const appStart = Date.now();
  const app = await getProviderApp(clientId);
  if (!app) {
    const elapsed = Date.now() - appStart;
    const minMs = 50;
    if (elapsed < minMs) {
      await new Promise((r) => setTimeout(r, minMs - elapsed));
    }
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "app not found",
        correlation_id: correlationId,
      },
      { status: 404 },
    );
  }

  const { clientId: m2mClientId, clientSecret } = clientCredentialsFromTokenRequest(
    request,
    form,
  );

  try {
    const session = await handleAppScopedSignerTokenExchange({
      publicClientId: clientId,
      clientId: m2mClientId,
      clientSecret,
      grantType: form.get("grant_type") || "",
      subjectToken: form.get("subject_token") || "",
      subjectTokenType: form.get("subject_token_type") || "",
      requestedTokenType: form.get("requested_token_type") || "",
      resource: form.get("resource") || "",
      audiences: form.getAll("audience"),
      correlationId,
    });

    await writeAuditLog({
      clientId: app.id,
      action: "app_oidc_token_exchange",
      status: "success",
      correlationId,
    });

    return NextResponse.json(session, {
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    });
  } catch (err) {
    if (err instanceof AppScopedSignerTokenExchangeError) {
      await writeAuditLog({
        clientId: app.id,
        action: "app_oidc_token_exchange",
        status: err.code,
        correlationId,
      });
      return tokenExchangeErrorResponse(err, correlationId);
    }
    console.error("[app-oidc-token] exchange error:", err);
    return NextResponse.json(
      {
        error: "server_error",
        error_description: "token exchange failed",
        correlation_id: correlationId,
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
      },
    );
  }
}
