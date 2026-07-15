import { NextRequest, NextResponse } from "next/server";

import {
  handleAppUsageBalanceGet,
  resolveAppForUsageAccess,
} from "@/lib/usage/app-usage-handlers";

/** Legacy usage balance route. Accepts M2M Basic or an authorized provider session. */
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
  });
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return handleAppUsageBalanceGet({ app, externalUserId });
}
