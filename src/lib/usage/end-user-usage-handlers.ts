import { NextRequest, NextResponse } from "next/server";

import {
  authenticateEndUser,
  endUserSubjectOverrideError,
} from "@/lib/auth/end-user";
import { isValidBoundedDateRange, MAX_DATE_RANGE_DAYS } from "@/lib/billing-utils";
import {
  listEndUserSignedTicketRequests,
  listEndUserSignedTicketSessions,
} from "@/lib/openmeter/signed-ticket-events";
import {
  handleAppUsageBalanceGet,
  handleAppUsageGet,
} from "@/lib/usage/app-usage-handlers";

/**
 * `publicClientId` is the app the credential must belong to. Omit it for the
 * pathless `/api/v1/user/usage*` routes, where the app is derived from the
 * credential itself.
 */
async function requireEndUserAuth(
  request: NextRequest,
  publicClientId: string | undefined,
  resourceLabel: string,
): Promise<
  | { auth: NonNullable<Awaited<ReturnType<typeof authenticateEndUser>>> }
  | { response: Response }
> {
  const override = endUserSubjectOverrideError(
    request.nextUrl.searchParams,
    resourceLabel,
  );
  if (override) {
    return { response: override };
  }

  const auth = await authenticateEndUser(request, {
    expectedPublicClientId: publicClientId,
  });
  if (!auth) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { auth };
}

/** End-user usage aggregates for path-scoped `/apps/{clientId}/me/usage`. */
export async function handleEndUserMeUsageGet(
  request: NextRequest,
  publicClientId?: string,
): Promise<Response> {
  const gate = await requireEndUserAuth(request, publicClientId, "usage");
  if ("response" in gate) {
    return gate.response;
  }

  return handleAppUsageGet({
    request,
    app: { id: gate.auth.developerAppId },
    forcedExternalUserId: gate.auth.externalUserId,
  });
}

/** End-user plan allowance for `/apps/{clientId}/me/usage/balance`. */
export async function handleEndUserMeUsageBalanceGet(
  request: NextRequest,
  publicClientId?: string,
): Promise<Response> {
  const gate = await requireEndUserAuth(request, publicClientId, "balance");
  if ("response" in gate) {
    return gate.response;
  }

  return handleAppUsageBalanceGet({
    app: { id: gate.auth.developerAppId },
    externalUserId: gate.auth.externalUserId,
  });
}

/** End-user signed-ticket history for `/apps/{clientId}/me/usage/requests`. */
export async function handleEndUserMeUsageRequestsGet(
  request: NextRequest,
  publicClientId?: string,
): Promise<Response> {
  const gate = await requireEndUserAuth(request, publicClientId, "requests");
  if ("response" in gate) {
    return gate.response;
  }
  const { auth } = gate;

  const params = request.nextUrl.searchParams;
  const cursor = params.get("cursor")?.trim() || undefined;
  const manifestId = params.get("manifestId")?.trim() || undefined;
  const groupBy = params.get("groupBy")?.trim().toLowerCase() || "request";
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const from = params.get("from")?.trim() || undefined;
  const to = params.get("to")?.trim() || undefined;

  if (groupBy !== "request" && groupBy !== "session") {
    return NextResponse.json(
      { error: "Invalid groupBy; use request or session" },
      { status: 400 },
    );
  }

  if ((from && !to) || (to && !from)) {
    return NextResponse.json(
      { error: "from and to must be supplied together" },
      { status: 400 },
    );
  }
  if (from && to && !isValidBoundedDateRange(from, to)) {
    return NextResponse.json(
      {
        error: `Invalid range; supply from <= to within ${MAX_DATE_RANGE_DAYS} days`,
      },
      { status: 400 },
    );
  }

  if (groupBy === "session") {
    const result = await listEndUserSignedTicketSessions({
      externalUserId: auth.externalUserId,
      clientId: auth.publicClientId,
      cursor,
      limit: Number.isFinite(limit) ? limit : undefined,
      from,
      to,
    });

    return NextResponse.json({
      items: result.items,
      nextCursor: result.nextCursor,
      openMeterConfigured: result.openMeterConfigured,
      clientId: auth.publicClientId,
      externalUserId: auth.externalUserId,
      groupBy: "session",
    });
  }

  const result = await listEndUserSignedTicketRequests({
    externalUserId: auth.externalUserId,
    clientId: auth.publicClientId,
    manifestId,
    cursor,
    limit: Number.isFinite(limit) ? limit : undefined,
    from,
    to,
  });

  return NextResponse.json({
    items: result.items,
    nextCursor: result.nextCursor,
    openMeterConfigured: result.openMeterConfigured,
    clientId: auth.publicClientId,
    externalUserId: auth.externalUserId,
    groupBy: "request",
  });
}
