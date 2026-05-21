import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/domains/identity-access/runtime/admin-auth";
import { getBillingTransactions } from "@/domains/end-user-accounts/runtime/billing";

export async function GET(request: NextRequest) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const endUserId = url.searchParams.get("endUserId");
  const limit = parseInt(url.searchParams.get("limit") || "50");
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const enriched = await getBillingTransactions({
    endUserId: endUserId || undefined,
    limit,
    offset,
  });

  return NextResponse.json({
    transactions: enriched,
    pagination: { limit, offset, hasMore: enriched.length === limit },
  });
}
