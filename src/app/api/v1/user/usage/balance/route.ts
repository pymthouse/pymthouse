import { NextRequest, NextResponse } from "next/server";

import { authenticateEndUser } from "@/lib/auth/end-user";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";

/**
 * End-user allowance balance for the Bearer subject only.
 * Auth: programmatic user JWT or signer JWT (subject forced — not queryable).
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateEndUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  if (params.has("externalUserId") || params.has("external_user_id")) {
    return NextResponse.json(
      {
        error:
          "externalUserId is not allowed; balance is scoped to the authenticated user",
      },
      { status: 400 },
    );
  }

  const balance = await getTrialCreditBalance({
    clientId: auth.developerAppId,
    externalUserId: auth.externalUserId,
  });
  if (!balance) {
    return NextResponse.json({ error: "OpenMeter not configured" }, { status: 503 });
  }

  return NextResponse.json({
    externalUserId: auth.externalUserId,
    ...balance,
    remainingUsdMicros: balance.balanceUsdMicros,
  });
}
