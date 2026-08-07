import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { authorizeOwnerWalletM2m } from "@/lib/billing/owner-wallet-m2m-auth";
import {
  formatUsdMicrosForDisplay,
  resolvedPayPerUseBehavior,
} from "@/lib/billing/pay-per-use-threshold";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";
import { ownerHasChargeablePaymentMethod } from "@/lib/openmeter/owner-payment-method";

/**
 * GET /api/v1/apps/{clientId}/billing/wallet — owner prepaid wallet summary
 * for Builder M2M integrations: current balance, whether an auto-debit
 * payment method is on file, and the resolved Pay-Per-Use settlement
 * behaviour (credits first, then auto-debit at the charge threshold).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeOwnerWalletM2m(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [balance, hasDefaultPaymentMethod, usagePlanRows] = await Promise.all([
    getOwnerPrepaidCreditBalance(access.ownerUserId),
    ownerHasChargeablePaymentMethod(access.ownerUserId),
    db
      .select({
        id: plans.id,
        name: plans.name,
        chargeThresholdUsdMicros: plans.chargeThresholdUsdMicros,
      })
      .from(plans)
      .where(
        and(
          eq(plans.clientId, access.app.id),
          eq(plans.type, "usage"),
          eq(plans.status, "active"),
        ),
      )
      .orderBy(desc(plans.updatedAt)),
  ]);

  return NextResponse.json({
    clientId,
    balance: balance
      ? {
          usdMicros: balance.balanceUsdMicros,
          usd: formatUsdMicrosForDisplay(balance.balanceUsdMicros),
          lifetimeGrantedUsdMicros: balance.lifetimeGrantedUsdMicros,
          consumedUsdMicros: balance.consumedUsdMicros,
        }
      : null,
    paymentMethod: {
      /** null = unknown (billing outage) — callers should fail open. */
      hasDefault: hasDefaultPaymentMethod,
    },
    /** Every active usage plan on the app (newest `updatedAt` first). */
    payPerUsePlans: usagePlanRows.map((usagePlan) => ({
      planId: usagePlan.id,
      planName: usagePlan.name,
      chargeThresholdUsdMicros: usagePlan.chargeThresholdUsdMicros ?? null,
      resolvedBehavior: resolvedPayPerUseBehavior(
        usagePlan.chargeThresholdUsdMicros,
      ),
    })),
    settlement: {
      order: "credits_then_auto_debit",
      description:
        "Accrued usage settles against prepaid credits first; the remainder auto-debits the default payment method when the charge threshold is reached.",
    },
  });
}
