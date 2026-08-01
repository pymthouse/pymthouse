import { NextRequest } from "next/server";

import { handleEndUserMeUsageGet } from "@/lib/usage/end-user-usage-handlers";

/**
 * Deprecated alias for `GET /api/v1/apps/{clientId}/me/usage`.
 * Same behavior; the app is derived from the Bearer credential instead of the path.
 */
export async function GET(request: NextRequest) {
  return handleEndUserMeUsageGet(request);
}
