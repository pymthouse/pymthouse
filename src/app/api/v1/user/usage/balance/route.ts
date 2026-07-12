import { NextResponse } from "next/server";

import { authenticateEndUser } from "@/lib/auth/end-user";
import { handleAppUsageBalanceGet } from "@/lib/usage/app-usage-handlers";

/**
 * End-user allowance balance for the Bearer subject only.
 * Auth: composite API key, bare app API key, or end-user/signer JWT.
 */
export async function GET(request: Request) {
  const auth = await authenticateEndUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  if (url.searchParams.has("externalUserId") || url.searchParams.has("external_user_id")) {
    return NextResponse.json(
      { error: "externalUserId is not allowed; balance is scoped to the authenticated user" },
      { status: 400 },
    );
  }

  return handleAppUsageBalanceGet({
    app: { id: auth.developerAppId },
    externalUserId: auth.externalUserId,
  });
}
