import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { getBillingUsageDashboardData } from "@/lib/billing-usage-dashboard-data";

/**
 * JSON billing/usage dashboard payload for the Usage page.
 * Query: appId (optional single app), scope=own|all (all = platform-wide for admins).
 * Bigints are stringified for transport.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const appId = url.searchParams.get("appId");
  const scopeParam = url.searchParams.get("scope");

  const session = await getServerSession(authOptions);
  const role = (session?.user as Record<string, unknown> | undefined)?.role as
    | string
    | undefined;
  const wantsAll = scopeParam === "all" && role === "admin";
  const ownAppsOnly = !wantsAll;

  const result = await getBillingUsageDashboardData(appId || undefined, {
    ownAppsOnly: appId ? false : ownAppsOnly,
  });

  if (!result.ok) {
    if (result.reason === "no_session") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (result.reason === "forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (result.reason === "openmeter_unconfigured") {
      return NextResponse.json({ error: "Usage unavailable" }, { status: 503 });
    }
    return NextResponse.json({ error: "Usage unavailable" }, { status: 404 });
  }

  const data = result.data;
  return NextResponse.json({
    ...data,
    totalFeeWei: data.totalFeeWei.toString(),
    totalNetworkFeeUsdMicros: data.totalNetworkFeeUsdMicros.toString(),
  });
}
