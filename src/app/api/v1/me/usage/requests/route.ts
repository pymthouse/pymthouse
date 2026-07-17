import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import {
  listAdminSignedTicketRequests,
  listViewerSignedTicketRequests,
} from "@/lib/openmeter/signed-ticket-events";

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = typeof sessionUser?.id === "string" ? sessionUser.id : undefined;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const scope = params.get("scope")?.trim().toLowerCase() || "own";
  const isAdmin = sessionUser?.role === "admin";

  if (scope === "all" && !isAdmin) {
    return NextResponse.json(
      { error: "Forbidden: scope=all requires admin" },
      { status: 403 },
    );
  }
  if (scope !== "own" && scope !== "all") {
    return NextResponse.json(
      { error: "Invalid scope; use own or all" },
      { status: 400 },
    );
  }

  const clientIds = [
    ...params.getAll("clientId").map((id) => id.trim()).filter(Boolean),
    ...(params.get("clientIds")?.split(",").map((id) => id.trim()).filter(Boolean) ??
      []),
  ];
  const uniqueClientIds = [...new Set(clientIds)];
  const cursor = params.get("cursor")?.trim() || undefined;
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  // Never accept externalUserId — own scope is viewer subjects; all scope is
  // platform-wide by clientId filter, not by arbitrary end-user id.
  if (params.has("externalUserId") || params.has("external_user_id")) {
    return NextResponse.json(
      {
        error:
          "externalUserId is not allowed; use scope=own (viewer) or scope=all (admin) with clientId filters",
      },
      { status: 400 },
    );
  }

  const listInput = {
    clientIds: uniqueClientIds.length > 0 ? uniqueClientIds : undefined,
    cursor,
    limit: Number.isFinite(limit) ? limit : undefined,
  };

  const result =
    scope === "all"
      ? await listAdminSignedTicketRequests(listInput)
      : await listViewerSignedTicketRequests({
          userId,
          ...listInput,
        });

  return NextResponse.json({
    items: result.items,
    nextCursor: result.nextCursor,
    openMeterConfigured: result.openMeterConfigured,
    scope,
  });
}
