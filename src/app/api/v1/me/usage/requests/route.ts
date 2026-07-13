import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import { listViewerSignedTicketRequests } from "@/lib/openmeter/signed-ticket-events";

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = typeof sessionUser?.id === "string" ? sessionUser.id : undefined;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const clientIds = [
    ...params.getAll("clientId").map((id) => id.trim()).filter(Boolean),
    ...(params.get("clientIds")?.split(",").map((id) => id.trim()).filter(Boolean) ??
      []),
  ];
  const uniqueClientIds = [...new Set(clientIds)];
  const cursor = params.get("cursor")?.trim() || undefined;
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  // Never accept externalUserId — viewers may only see their own subjects.
  if (params.has("externalUserId") || params.has("external_user_id")) {
    return NextResponse.json(
      { error: "externalUserId is not allowed; requests are scoped to the signed-in user" },
      { status: 400 },
    );
  }

  const result = await listViewerSignedTicketRequests({
    userId,
    clientIds: uniqueClientIds.length > 0 ? uniqueClientIds : undefined,
    cursor,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  return NextResponse.json({
    items: result.items,
    nextCursor: result.nextCursor,
    openMeterConfigured: result.openMeterConfigured,
  });
}
