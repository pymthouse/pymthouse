import { NextResponse } from "next/server";

import {
  handleAppUsageGet,
  resolveAppForUsageAccess,
} from "@/lib/usage/app-usage-handlers";

/** Builder API: M2M Basic only (no provider session). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveAppForUsageAccess({
    request,
    clientId,
    m2mOnly: true,
  });
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return handleAppUsageGet({ request, app });
}
