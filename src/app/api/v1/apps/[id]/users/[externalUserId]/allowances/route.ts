import { NextRequest, NextResponse } from "next/server";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = decodeURIComponent(raw);
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const balance = await getTrialCreditBalance({
    clientId: access.app.id,
    externalUserId,
  });
  if (!balance) {
    return NextResponse.json({ error: "OpenMeter not configured" }, { status: 503 });
  }

  return NextResponse.json({
    externalUserId,
    allowances: {
      balanceUsdMicros: balance.balanceUsdMicros,
      consumedUsdMicros: balance.consumedUsdMicros,
      lifetimeGrantedUsdMicros: balance.lifetimeGrantedUsdMicros,
      hasAccess: balance.hasAccess,
    },
  });
}

/**
 * Free prepaid grants are admin-only (customer-service /
 * POST /api/v1/admin/billing/owners/{userId}/grants). Paid top-ups use Stripe
 * Checkout + webhook; onramp settle remains a separate admin path.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(
    {
      type: "https://pymthouse.com/problems/free-grant-admin-only",
      title: "Free credit grants are admin-only",
      status: 403,
      code: "free_grant_admin_only",
      detail:
        "Manual prepaid credit grants must use POST /api/v1/admin/billing/owners/{userId}/grants (platform admin). For paid balance top-ups use the wallet top-up / Stripe Checkout flow.",
    },
    {
      status: 403,
      headers: { "Content-Type": "application/problem+json" },
    },
  );
}
