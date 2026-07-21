import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import {
  listAdminSignedTicketRequests,
  listAdminSignedTicketSessions,
  listViewerSignedTicketRequests,
  listViewerSignedTicketSessions,
} from "@/lib/openmeter/signed-ticket-events";

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

export async function GET(request: NextRequest) {
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
  const cursor = params.get("cursor")?.trim() || undefined;
  const manifestId = params.get("manifestId")?.trim() || undefined;
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  const listInput = {
    clientIds: uniqueClientIds.length > 0 ? uniqueClientIds : undefined,
    cursor,
    limit: Number.isFinite(limit) ? limit : undefined,
  };

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
}
