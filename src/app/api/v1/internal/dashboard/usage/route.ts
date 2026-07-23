import { NextRequest } from "next/server";

import { handleDashboardUsageGet } from "@/lib/usage/dashboard-usage-handler";

/** Internal alias of GET /api/v1/dashboard/usage */
export async function GET(request: NextRequest) {
  return handleDashboardUsageGet(request);
}
