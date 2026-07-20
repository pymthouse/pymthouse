import { NextRequest, NextResponse } from "next/server";

import {
  authenticateEndUser,
  endUserSubjectOverrideError,
} from "@/lib/auth/end-user";
import { listEndUserSignedTicketRequests } from "@/lib/openmeter/signed-ticket-events";

/**
 * End-user signed-ticket request history for the Bearer subject only.
 * Auth: end-user / signer JWT (subject forced from the token — not queryable).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const override = endUserSubjectOverrideError(params, "requests");
  if (override) {
    return override;
  }

  const auth = await authenticateEndUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
