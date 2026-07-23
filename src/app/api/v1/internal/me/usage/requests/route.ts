import { NextRequest } from "next/server";

import { handleMeUsageRequestsGet } from "@/lib/usage/me-usage-requests-handler";

/** Internal alias of GET /api/v1/me/usage/requests */
export async function GET(request: NextRequest) {
  return handleMeUsageRequestsGet(request);
}
