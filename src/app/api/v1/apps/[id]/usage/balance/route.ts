import { NextRequest, NextResponse } from "next/server";

import { requireExternalUserId } from "@/lib/external-user-id";
import {
  handleAppUsageBalanceGet,
  resolveAppForUsageAccess,
} from "@/lib/usage/app-usage-handlers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const parsedId = requireExternalUserId(
    request.nextUrl.searchParams.get("externalUserId"),
  );
  if (!parsedId.ok) return parsedId.response;

  const app = await resolveAppForUsageAccess({
    request,
    clientId,
  });
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return handleAppUsageBalanceGet({
    app,
    externalUserId: parsedId.externalUserId,
  });
}
