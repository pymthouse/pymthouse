import { NextRequest, NextResponse } from "next/server";
import { createCorrelationId } from "@/lib/audit";
import { ApiKeyCredentialError, parseAppApiKeyBearer } from "@/lib/openapi/api-key";
import { z } from "@/lib/openapi/zod";
import { getProviderApp } from "@/lib/provider-apps";

export type ApiKeyRouteContext = {
  apiKey: string;
  app: NonNullable<Awaited<ReturnType<typeof getProviderApp>>>;
  correlationId: string;
  clientId: string;
};

export function isApiKeyRouteContext(
  value: ApiKeyRouteContext | NextResponse,
): value is ApiKeyRouteContext {
  return !(value instanceof NextResponse);
}

export function apiKeyOAuthError(
  correlationId: string,
  error: string,
  errorDescription: string,
  status: number,
) {
  return NextResponse.json(
    {
      error,
      error_description: errorDescription,
      correlation_id: correlationId,
    },
    { status },
  );
}

export async function authenticateApiKeyBearerRoute(
  request: NextRequest,
  clientId: string,
): Promise<ApiKeyRouteContext | NextResponse> {
  const correlationId = createCorrelationId();
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return apiKeyOAuthError(
      correlationId,
      "invalid_request",
      "Authorization Bearer API key is required",
      401,
    );
  }

  let apiKey: string;
  try {
    apiKey = parseAppApiKeyBearer(authHeader.slice(7).trim());
  } catch (err) {
    if (err instanceof ApiKeyCredentialError) {
      return apiKeyOAuthError(correlationId, err.code, err.message, err.status);
    }
    throw err;
  }

  const app = await getProviderApp(clientId);
  if (!app) {
    return apiKeyOAuthError(
      correlationId,
      "not_found",
      "developer app was not found for this client_id",
      404,
    );
  }

  return { apiKey, app, correlationId, clientId };
}

export async function parseApiKeyRouteJsonBody<T extends z.ZodTypeAny>(
  request: NextRequest,
  schema: T,
  correlationId: string,
): Promise<z.infer<T> | NextResponse> {
  const rawBody = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return apiKeyOAuthError(
      correlationId,
      "invalid_request",
      parsed.error.issues[0]?.message ?? "Invalid request body",
      400,
    );
  }
  return parsed.data;
}
