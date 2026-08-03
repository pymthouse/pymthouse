import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import {
  listAdminSignedTicketRequests,
  listAdminSignedTicketSessions,
  listViewerSignedTicketRequests,
  listViewerSignedTicketSessions,
} from "@/lib/openmeter/signed-ticket-events";
import { resolveViewerUsageClientIds } from "@/lib/viewer-usage-clients";
import {
  isValidBoundedDateRange,
  MAX_DATE_RANGE_DAYS,
} from "@/lib/billing-utils";

type MeUsageGroupBy = "request" | "session";
type MeUsageScope = "own" | "all";

function parseUniqueClientIds(params: URLSearchParams): string[] {
  const clientIds = [
    ...params.getAll("clientId").map((id) => id.trim()).filter(Boolean),
    ...(params.get("clientIds")?.split(",").map((id) => id.trim()).filter(Boolean) ??
      []),
  ];
  return [...new Set(clientIds)];
}

function validateMeUsageRequestsParams(
  params: URLSearchParams,
  isAdmin: boolean,
):
  | { error: NextResponse }
  | { scope: MeUsageScope; groupBy: MeUsageGroupBy } {
  const scope = (params.get("scope")?.trim().toLowerCase() || "own") as string;
  const groupBy = (params.get("groupBy")?.trim().toLowerCase() ||
    "request") as string;

  if (scope === "all" && !isAdmin) {
    return {
      error: NextResponse.json(
        { error: "Forbidden: scope=all requires admin" },
        { status: 403 },
      ),
    };
  }
  if (scope !== "own" && scope !== "all") {
    return {
      error: NextResponse.json(
        { error: "Invalid scope; use own or all" },
        { status: 400 },
      ),
    };
  }
  if (groupBy !== "request" && groupBy !== "session") {
    return {
      error: NextResponse.json(
        { error: "Invalid groupBy; use request or session" },
        { status: 400 },
      ),
    };
  }
  // Never accept externalUserId — own scope is viewer subjects; all scope is
  // platform-wide by clientId filter, not by arbitrary end-user id.
  if (params.has("externalUserId") || params.has("external_user_id")) {
    return {
      error: NextResponse.json(
        {
          error:
            "externalUserId is not allowed; use scope=own (viewer) or scope=all (admin) with clientId filters",
        },
        { status: 400 },
      ),
    };
  }

  return { scope, groupBy };
}

function parseOptionalDateRange(
  params: URLSearchParams,
): { error: NextResponse } | { from?: string; to?: string } {
  // Optional date range for the requests table's range picker. Both bounds are
  // required together and are span-limited before hitting OpenMeter.
  const from = params.get("from")?.trim() || undefined;
  const to = params.get("to")?.trim() || undefined;
  if ((from && !to) || (to && !from)) {
    return {
      error: NextResponse.json(
        { error: "from and to must be supplied together" },
        { status: 400 },
      ),
    };
  }
  if (from && to && !isValidBoundedDateRange(from, to)) {
    return {
      error: NextResponse.json(
        {
          error: `Invalid range; supply from <= to within ${MAX_DATE_RANGE_DAYS} days`,
        },
        { status: 400 },
      ),
    };
  }
  return { from, to };
}

/** Session-authenticated viewer signed-ticket history (Internal API). */
export async function handleMeUsageRequestsGet(
  request: NextRequest,
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = typeof sessionUser?.id === "string" ? sessionUser.id : undefined;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const isAdmin = sessionUser?.role === "admin";
  const validated = validateMeUsageRequestsParams(params, Boolean(isAdmin));
  if ("error" in validated) {
    return validated.error;
  }
  const { scope, groupBy } = validated;

  const uniqueClientIds = parseUniqueClientIds(params);
  // scope=own with no explicit filter: authorize the viewer's owned/admin apps
  // plus app_users memberships (including personal network on the default app).
  // Sessions require a concrete clientId set; request history benefits too.
  let resolvedClientIds = uniqueClientIds;
  if (scope === "own" && resolvedClientIds.length === 0) {
    resolvedClientIds = await resolveViewerUsageClientIds(userId);
  }

  const cursor = params.get("cursor")?.trim() || undefined;
  const manifestId = params.get("manifestId")?.trim() || undefined;
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  const dateRange = parseOptionalDateRange(params);
  if ("error" in dateRange) {
    return dateRange.error;
  }

  const listInput = {
    clientIds: resolvedClientIds.length > 0 ? resolvedClientIds : undefined,
    cursor,
    limit: Number.isFinite(limit) ? limit : undefined,
    from: dateRange.from,
    to: dateRange.to,
  };

  try {
    if (groupBy === "session") {
      const result =
        scope === "all"
          ? await listAdminSignedTicketSessions(listInput)
          : await listViewerSignedTicketSessions({
              userId,
              ...listInput,
            });

      return NextResponse.json({
        items: result.items,
        nextCursor: result.nextCursor,
        openMeterConfigured: result.openMeterConfigured,
        scope,
        groupBy: "session",
      });
    }

    const requestInput = {
      ...listInput,
      manifestId,
    };

    const result =
      scope === "all"
        ? await listAdminSignedTicketRequests(requestInput)
        : await listViewerSignedTicketRequests({
            userId,
            ...requestInput,
          });

    return NextResponse.json({
      items: result.items,
      nextCursor: result.nextCursor,
      openMeterConfigured: result.openMeterConfigured,
      scope,
      groupBy: "request",
    });
  } catch (err) {
    console.error("[me-usage-requests] OpenMeter list failed:", err);
    return NextResponse.json(
      { error: "Failed to load usage requests" },
      { status: 502 },
    );
  }
}
