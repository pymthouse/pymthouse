import { NextRequest } from "next/server";

import { handleEndUserMeUsageGet } from "@/lib/usage/end-user-usage-handlers";

/**
 * End-user usage aggregates for the Bearer subject.
 * Auth: bare `pmth_*` API key, optional composite `app_*_*`, or end-user/signer JWT.
 * App is derived from the credential (no `{clientId}` in the path).
 */
export async function GET(request: NextRequest) {
  return handleEndUserMeUsageGet(request);
}
