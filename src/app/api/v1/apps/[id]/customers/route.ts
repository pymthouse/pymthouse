import { NextResponse } from "next/server";

import { getAppCustomersList } from "@/lib/app-customers";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";

/**
 * Session dashboard: provisioned app users for one app with cycle spend +
 * spendable/subscription summaries (owner / provider admin / platform admin).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await getAuthorizedProviderApp(id);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await getAppCustomersList(auth.app);
  return NextResponse.json(payload);
}
