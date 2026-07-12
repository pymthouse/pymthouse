import { NextRequest } from "next/server";

import { handleDashboardUsageGet } from "@/lib/usage/dashboard-usage-handler";

export async function GET(request: NextRequest) {
  return handleDashboardUsageGet(request);
}
