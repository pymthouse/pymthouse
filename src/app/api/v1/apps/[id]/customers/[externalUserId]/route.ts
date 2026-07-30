import { NextResponse } from "next/server";

import { getAppCustomerDetail } from "@/lib/app-customers";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";

/**
 * Session dashboard: single provisioned app user detail (profile, spendable,
 * subscription, cycle usage).
 */
export async function GET(
  _request: Request,
  {
    params,
  }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id, externalUserId } = await params;
  const auth = await getAuthorizedProviderApp(id);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const decoded = decodeURIComponent(externalUserId);
  const payload = await getAppCustomerDetail(auth.app, decoded);
  if (!payload) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json(payload);
}
