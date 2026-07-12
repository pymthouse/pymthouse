import { NextRequest, NextResponse } from "next/server";

import {
  authenticateEndUser,
  endUserSubjectOverrideError,
} from "@/lib/auth/end-user";
import { handleAppUsageGet } from "@/lib/usage/app-usage-handlers";

/**
 * End-user usage aggregates for the Bearer subject only.
 * Auth: composite API key, bare app API key, or end-user/signer JWT.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const override = endUserSubjectOverrideError(params, "usage");
  if (override) {
    return override;
  }

  const auth = await authenticateEndUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return handleAppUsageGet({
    request,
    app: { id: auth.developerAppId },
    forcedExternalUserId: auth.externalUserId,
  });
}
