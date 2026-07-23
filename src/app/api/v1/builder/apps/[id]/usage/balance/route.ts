import { NextRequest, NextResponse } from "next/server";

import {
  handleAppUsageBalanceGet,
  resolveAppForUsageAccess,
} from "@/lib/usage/app-usage-handlers";

/** Builder API: M2M Basic only (no provider session). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const externalUserId = request.nextUrl.searchParams.get("externalUserId")?.trim();
  if (!externalUserId) {
    return NextResponse.json({ error: "externalUserId is required" }, { status: 400 });
  }

  const app = await resolveAppForUsageAccess({
    request,
    clientId,
    m2mOnly: true,
  });
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return handleAppUsageBalanceGet({ app, externalUserId });
}
