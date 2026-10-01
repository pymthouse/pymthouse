import { NextRequest, NextResponse } from "next/server";

import { meBillingV2Path } from "@/lib/api-version/v2-surface";
import { EXTERNAL_USER_ID_REQUIRED_CODE } from "@/lib/billing/wallet-billing-target";

/** M2M tried to act on an end user's billing — use `/me/billing` with their Bearer. */
export const END_USER_CREDENTIAL_REQUIRED_CODE = "end_user_credential_required";

const SUBJECT_KEYS = ["externalUserId", "external_user_id", "userId"] as const;

type AppRouteContext = { params: Promise<{ id: string }> };

type AppRouteHandler<C extends AppRouteContext> = (
  request: NextRequest,
  context: C,
) => Promise<Response> | Response;

/** True when the query (any value) or JSON body (non-empty string) names a subject. */
async function namesSubject(request: NextRequest): Promise<boolean> {
  const params = request.nextUrl.searchParams;
  if (SUBJECT_KEYS.some((key) => params.has(key))) {
    return true;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return false;
  }
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return false;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const record = body as Record<string, unknown>;
  return SUBJECT_KEYS.some((key) => {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

/** 403 pointing the caller at the end-user `/me/billing` successor. */
export function endUserCredentialRequiredResponse(
  clientId: string,
  successorSuffix: string,
): Response {
  const successor = meBillingV2Path(clientId, successorSuffix);
  return NextResponse.json(
    {
      error:
        "M2M cannot act on an end user's billing in /api/v2. " +
        `Call ${successor} with the end user's Bearer credential.`,
      code: END_USER_CREDENTIAL_REQUIRED_CODE,
    },
    {
      status: 403,
      headers: { Link: `<${successor}>; rel="successor-version"` },
    },
  );
}

/**
 * v2 wrapper for owner-wallet routes whose v1 handler also accepts a merchant
 * end user via `externalUserId`. In v2 the subject can never be named by M2M:
 *
 * - a query / body subject → 403 `end_user_credential_required` (checked before
 *   auth; the response does not depend on the app, so nothing leaks)
 * - a merchant app, where the route only targets end users → the v1 handler's
 *   400 `external_user_id_required` becomes the same 403
 */
export function withoutSubjectOverride<C extends AppRouteContext>(
  handler: AppRouteHandler<C>,
  successorSuffix: string,
) {
  return async function v2OwnerWalletHandler(
    request: NextRequest,
    context: C,
  ): Promise<Response> {
    const { id } = await context.params;
    const clientId = id?.trim() ?? "";
    if (await namesSubject(request)) {
      return endUserCredentialRequiredResponse(clientId, successorSuffix);
    }
    const response = await handler(request, context);
    if (
      response.status === 400 &&
      (await readErrorCode(response)) === EXTERNAL_USER_ID_REQUIRED_CODE
    ) {
      return endUserCredentialRequiredResponse(clientId, successorSuffix);
    }
    return response;
  };
}
