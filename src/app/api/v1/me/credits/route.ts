import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { resolveOwnerBillingPressure } from "@/lib/billing/owner-billing-pressure";
import { authOptions } from "@/lib/next-auth-options";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";
import { listOwnerPaymentMethods } from "@/lib/openmeter/owner-payment-method";
import { listOwnerActiveSubscriptions } from "@/lib/owner-billing-data";

/**
 * Lightweight owner prepaid credit summary for the dashboard sidebar.
 * Single Konnect customer lookup (`owner:{users.id}`) — not an end-user sum.
 * Also returns billingPressure so the sidebar can nudge cardless exhausted owners.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = typeof sessionUser?.id === "string" ? sessionUser.id : undefined;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [creditAllowance, subscriptions, paymentMethods] = await Promise.all([
    getOwnerPrepaidCreditBalance(userId),
    listOwnerActiveSubscriptions(userId).catch((err) => {
      console.warn(
        "me/credits: subscription lookup failed",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }),
    listOwnerPaymentMethods(userId).catch((err) => {
      console.warn(
        "me/credits: payment method lookup failed",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }),
  ]);

  const billingPressure = resolveOwnerBillingPressure({
    hasPaymentMethod: paymentMethods.length > 0,
    creditBalanceUsdMicros: creditAllowance?.balanceUsdMicros ?? null,
    subscriptions,
  });

  if (!creditAllowance) {
    return NextResponse.json({ creditAllowance: null, billingPressure });
  }

  return NextResponse.json({ creditAllowance, billingPressure });
}
