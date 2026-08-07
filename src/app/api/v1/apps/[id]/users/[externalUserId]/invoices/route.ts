import { NextRequest, NextResponse } from "next/server";

import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import { tryDecodeURIComponent } from "@/lib/billing-utils";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { listAppUserInvoices } from "@/lib/openmeter/invoices";

/**
 * GET /api/v1/apps/{clientId}/users/{externalUserId}/invoices
 *
 * End-user-scoped invoice list (OpenMeter customer for this app user).
 * Auth: same as other app-user billing routes (`authorizeAppForBilling`).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = tryDecodeURIComponent(raw)?.trim() ?? "";
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

  if (!isHostedAdminClientAvailable()) {
    return NextResponse.json({ error: "Billing unavailable" }, { status: 503 });
  }

  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") || "1");
  const pageSize = Number(url.searchParams.get("pageSize") || "20");

  try {
    const result = await listAppUserInvoices({
      client: getHostedAdminClient(),
      clientId: access.app.id,
      externalUserId,
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.warn(
      "app-user-invoices: list failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Billing unavailable" }, { status: 503 });
  }
}
