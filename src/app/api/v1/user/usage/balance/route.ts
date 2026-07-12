import { NextRequest, NextResponse } from "next/server";

import {
  authenticateEndUser,
  endUserSubjectOverrideError,
} from "@/lib/auth/end-user";
import { handleAppUsageBalanceGet } from "@/lib/usage/app-usage-handlers";

/**
 * End-user allowance balance for the Bearer subject only.
 * Auth: composite API key, bare app API key, or end-user/signer JWT.
 *
 * Returns the plan's included usage discount for the cycle (granted / remaining /
 * consumed), not prepaid trial-credit ledger fields.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const override = endUserSubjectOverrideError(params, "balance");
  if (override) {
    return override;
  }

  const auth = await authenticateEndUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return handleAppUsageBalanceGet({
    app: { id: auth.developerAppId },
    externalUserId: auth.externalUserId,
  });
}
