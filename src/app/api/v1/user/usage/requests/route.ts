import { NextRequest } from "next/server";

import { handleEndUserMeUsageRequestsGet } from "@/lib/usage/end-user-usage-handlers";

/**
 * Deprecated alias for `GET /api/v1/apps/{clientId}/me/usage/requests`.
 * Same behavior; the app is derived from the Bearer credential instead of the path.
 */
export async function GET(request: NextRequest) {
  return handleEndUserMeUsageRequestsGet(request);
}
