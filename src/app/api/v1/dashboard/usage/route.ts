import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { getDashboardUsageSummary } from "@/lib/dashboard-usage-summary";

const ADMIN_ROLES = new Set(["admin", "operator"]);

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as Record<string, unknown>).role as string | undefined;
  const wantsAll = new URL(request.url).searchParams.get("scope") === "all";
  const ownAppsOnly = !(wantsAll && role && ADMIN_ROLES.has(role));

  const summary = await getDashboardUsageSummary(ownAppsOnly);
  if (!summary) {
    return NextResponse.json({ error: "Usage unavailable" }, { status: 404 });
  }

  return NextResponse.json(summary);
}
