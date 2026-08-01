import { NextRequest, NextResponse } from "next/server";

import { handleEndUserMeUsageGet } from "@/lib/usage/end-user-usage-handlers";

/**
 * End-user usage aggregates for the Bearer subject on this app.
 * Auth: bare `pmth_*` API key, optional composite `app_*_*`, or end-user/signer JWT.
 * Path `{id}` must match the credential's public client id.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  if (!clientId?.trim()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return handleEndUserMeUsageGet(request, clientId.trim());
}
