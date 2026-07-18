import { NextRequest, NextResponse } from "next/server";

import { authenticateEndUser } from "@/lib/auth/end-user";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import {
  buildAppUsageResponse,
  parseUsageQueryParams,
  validateUsageDateParams,
} from "@/lib/usage/build-app-usage-response";

/**
 * End-user usage for the Bearer subject only.
 * Auth: programmatic user JWT or signer JWT (subject forced — not queryable).
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateEndUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  if (
    params.has("externalUserId") ||
    params.has("external_user_id") ||
    params.has("userId")
  ) {
    return NextResponse.json(
      {
        error:
          "userId/externalUserId are not allowed; usage is scoped to the authenticated user",
      },
      { status: 400 },
    );
  }

  if (!requireOpenMeterForUsageReads()) {
    return NextResponse.json(
      { error: "OpenMeter not configured (OPENMETER_URL required)" },
      { status: 503 },
    );
  }

  const { startDate, endDate, groupBy, includeRetail } = parseUsageQueryParams(params);
  const dateError = validateUsageDateParams(startDate, endDate);
  if (dateError) {
    return NextResponse.json({ error: dateError }, { status: 400 });
  }

  const response = await buildAppUsageResponse({
    appId: auth.developerAppId,
    startDate,
    endDate,
    groupBy,
    filterUserId: auth.externalUserId,
    includeRetail,
  });
  return NextResponse.json(response);
}
