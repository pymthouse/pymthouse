import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import {
  listAdminSignedTicketRequests,
  listAdminSignedTicketSessions,
  listDeveloperSignedTicketRequests,
  listDeveloperSignedTicketSessions,
} from "@/lib/openmeter/signed-ticket-events";
import {
  resolveViewerUsageClientScopes,
  type ViewerUsageClientScopes,
} from "@/lib/viewer-usage-clients";
import { parseOptionalDateRange } from "@/lib/usage/parse-optional-date-range";

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

/** Optional identity filter (`?externalUserId=` repeated, or comma-separated). */
function parseExternalUserIds(params: URLSearchParams): string[] {
  const ids = [
    ...params.getAll("externalUserId").map((id) => id.trim()).filter(Boolean),
    ...(params
      .get("externalUserIds")
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? []),
  ];
  return [...new Set(ids)];
}

/**
 * Restrict requested apps to what the viewer may read, keeping the
 * managed/membership split so managed apps can be read app-wide.
 */
function restrictScopesToRequested(
  scopes: ViewerUsageClientScopes,
  requested: string[],
): ViewerUsageClientScopes {
  if (requested.length === 0) return scopes;
  const wanted = new Set(requested);
  return {
    managed: scopes.managed.filter((id) => wanted.has(id)),
    member: scopes.member.filter((id) => wanted.has(id)),
  };
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
  return { scope, groupBy };
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
  const externalUserIds = parseExternalUserIds(params);
  // scope=own always resolves against the viewer's own authorization: apps they
  // own or administer (readable app-wide, every identity) plus app_users
  // memberships (their own subjects only). Requested clientIds only narrow it.
  const viewerScopes =
    scope === "own"
      ? restrictScopesToRequested(
          await resolveViewerUsageClientScopes(userId),
          uniqueClientIds,
        )
      : { managed: [], member: [] };

  const cursor = params.get("cursor")?.trim() || undefined;
  const manifestId = params.get("manifestId")?.trim() || undefined;
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  const dateRange = parseOptionalDateRange(params);
  if ("error" in dateRange) {
    return dateRange.error;
  }

  const listInput = {
    externalUserIds: externalUserIds.length > 0 ? externalUserIds : undefined,
    cursor,
    limit: Number.isFinite(limit) ? limit : undefined,
    from: dateRange.from,
    to: dateRange.to,
  };
  const adminInput = {
    ...listInput,
    clientIds: uniqueClientIds.length > 0 ? uniqueClientIds : undefined,
  };
  const developerInput = {
    ...listInput,
    userId,
    managedClientIds: viewerScopes.managed,
    memberClientIds: viewerScopes.member,
  };

  try {
    if (groupBy === "session") {
      const result =
        scope === "all"
          ? await listAdminSignedTicketSessions(adminInput)
          : await listDeveloperSignedTicketSessions(developerInput);

      return NextResponse.json({
        items: result.items,
        nextCursor: result.nextCursor,
        openMeterConfigured: result.openMeterConfigured,
        scope,
        groupBy: "session",
      });
    }

    const result =
      scope === "all"
        ? await listAdminSignedTicketRequests({ ...adminInput, manifestId })
        : await listDeveloperSignedTicketRequests({
            ...developerInput,
            manifestId,
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
