import { NextRequest, NextResponse } from "next/server";

import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import { tryDecodeURIComponent } from "@/lib/billing-utils";
import { getProviderApp } from "@/lib/provider-apps";

type ProviderApp = NonNullable<Awaited<ReturnType<typeof getProviderApp>>>;

export type AppUserBillingAccess = {
  app: ProviderApp;
  externalUserId: string;
};

/**
 * Decode `{externalUserId}`, authorize via `authorizeAppForBilling`, or return
 * a 400/404 response. Shared by end-user invoice + payment-method routes.
 */
export async function authorizeAppUserBillingRoute(
  request: NextRequest,
  clientId: string,
  rawExternalUserId: string,
): Promise<AppUserBillingAccess | NextResponse> {
  const externalUserId = tryDecodeURIComponent(rawExternalUserId)?.trim() ?? "";
  if (!externalUserId) {
    return NextResponse.json(
      { error: "externalUserId is required" },
      { status: 400 },
    );
  }
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return { app: access.app, externalUserId };
}

export function isAppUserBillingAccess(
  value: AppUserBillingAccess | NextResponse,
): value is AppUserBillingAccess {
  return !(value instanceof NextResponse);
}
