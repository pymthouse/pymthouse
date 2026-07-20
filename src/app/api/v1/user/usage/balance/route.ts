import { NextRequest, NextResponse } from "next/server";

import {
  authenticateEndUser,
  endUserSubjectOverrideError,
} from "@/lib/auth/end-user";
import { getUsageBalanceAllowance } from "@/lib/openmeter/spendable-allowance";

/**
 * End-user allowance balance for the Bearer subject only.
 * Auth: programmatic user JWT or signer JWT (subject forced — not queryable).
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

  const balance = await getUsageBalanceAllowance({
    clientId: auth.developerAppId,
    externalUserId: auth.externalUserId,
  });
  if (!balance) {
    return NextResponse.json({ error: "OpenMeter not configured" }, { status: 503 });
  }

  return NextResponse.json({
    externalUserId: auth.externalUserId,
    ...balance,
  });
}
