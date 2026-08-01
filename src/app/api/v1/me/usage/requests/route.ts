import { NextRequest } from "next/server";

import { handleMeUsageRequestsGet } from "@/lib/usage/me-usage-requests-handler";

export async function GET(request: NextRequest) {
  return handleMeUsageRequestsGet(request);
}
