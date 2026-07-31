import { NextResponse } from "next/server";

import {
  handleAppUsageGet,
  resolveAppForUsageAccess,
} from "@/lib/usage/app-usage-handlers";

/** Legacy usage route. Accepts M2M Basic or an authorized provider session. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveAppForUsageAccess({
    request,
    clientId,
  });
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return handleAppUsageGet({ request, app });
}
