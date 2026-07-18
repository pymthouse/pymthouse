import { NextResponse } from "next/server";

import { authenticateEndUser } from "@/lib/auth/end-user";
import { handleAppUsageGet } from "@/lib/usage/app-usage-handlers";

/**
 * End-user usage aggregates for the Bearer subject only.
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
      { error: "externalUserId is not allowed; usage is scoped to the authenticated user" },
      { status: 400 },
    );
  }
  if (url.searchParams.has("userId") && url.searchParams.get("userId")?.trim() !== auth.externalUserId) {
    return NextResponse.json(
      { error: "userId must match the authenticated user or be omitted" },
      { status: 400 },
    );
  }

  return handleAppUsageGet({
    request,
    app: { id: auth.developerAppId },
    forcedExternalUserId: auth.externalUserId,
  });
}
