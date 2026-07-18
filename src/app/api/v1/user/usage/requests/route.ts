import { NextRequest, NextResponse } from "next/server";

import { authenticateEndUser } from "@/lib/auth/end-user";
import { listEndUserSignedTicketRequests } from "@/lib/openmeter/signed-ticket-events";

/**
 * End-user signed-ticket request history for the Bearer subject only.
 * Auth: end-user / signer JWT (subject forced from the token — not queryable).
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateEndUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  if (params.has("externalUserId") || params.has("external_user_id")) {
    return NextResponse.json(
      {
        error:
          "externalUserId is not allowed; requests are scoped to the authenticated user",
      },
      { status: 400 },
    );
  }

  const cursor = params.get("cursor")?.trim() || undefined;
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  const result = await listEndUserSignedTicketRequests({
    externalUserId: auth.externalUserId,
    clientId: auth.publicClientId,
    cursor,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  return NextResponse.json({
    items: result.items,
    nextCursor: result.nextCursor,
    openMeterConfigured: result.openMeterConfigured,
    clientId: auth.publicClientId,
    externalUserId: auth.externalUserId,
  });
}
