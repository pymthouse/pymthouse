import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { authorizeOwnerWalletM2m } from "@/lib/billing/owner-wallet-m2m-auth";
import {
  formatUsdMicrosForDisplay,
  resolvedPayPerUseBehavior,
} from "@/lib/billing/pay-per-use-threshold";
import {
  readOptionalExternalUserId,
  resolveWalletBillingTarget,
} from "@/lib/billing/wallet-billing-target";
import { listAppUserPaymentMethods } from "@/lib/openmeter/app-user-payment-method";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { ownerHasChargeablePaymentMethod } from "@/lib/openmeter/owner-payment-method";

/**
 * GET /api/v1/apps/{clientId}/billing/wallet — prepaid wallet summary for
 * Builder M2M integrations. Branches on `app_billing_config.billing_mode`:
 * merchant → end-user balance (`externalUserId` required); otherwise owner rollup.
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

  const externalUserId = readOptionalExternalUserId(
    request.nextUrl.searchParams.get("externalUserId"),
  );
  const billingTarget = await resolveWalletBillingTarget({
    appId: access.app.id,
    ownerUserId: access.ownerUserId,
    externalUserId,
  });
  if (!billingTarget.ok) {
    return NextResponse.json(
      { error: billingTarget.error },
      { status: billingTarget.status },
    );
  }

  const usagePlanRowsPromise = db
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
    .orderBy(desc(plans.updatedAt));

  if (billingTarget.target.mode === "merchant") {
    const [trialBalance, paymentMethods, usagePlanRows] = await Promise.all([
      getTrialCreditBalance({
        clientId,
        externalUserId: billingTarget.target.externalUserId,
      }),
      listAppUserPaymentMethods({
        clientId: access.app.id,
        externalUserId: billingTarget.target.externalUserId,
      }).catch(() => null),
      usagePlanRowsPromise,
    ]);
    const balance = trialBalance
      ? {
          usdMicros: trialBalance.balanceUsdMicros,
          usd: formatUsdMicrosForDisplay(trialBalance.balanceUsdMicros),
          lifetimeGrantedUsdMicros: trialBalance.lifetimeGrantedUsdMicros,
          consumedUsdMicros: trialBalance.consumedUsdMicros,
        }
      : null;
    return NextResponse.json({
      clientId,
      balance,
      paymentMethod: {
        // null = unknown (provider outage), matching ownerHasChargeablePaymentMethod.
        hasDefault: paymentMethods
          ? paymentMethods.some((pm) => pm.isDefault)
          : null,
      },
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

  const [ownerBalance, hasDefaultPaymentMethod, usagePlanRows] =
    await Promise.all([
      getOwnerPrepaidCreditBalance(billingTarget.target.ownerUserId),
      ownerHasChargeablePaymentMethod(billingTarget.target.ownerUserId),
      usagePlanRowsPromise,
    ]);

  return NextResponse.json({
    clientId,
    balance: ownerBalance
      ? {
          usdMicros: ownerBalance.balanceUsdMicros,
          usd: formatUsdMicrosForDisplay(ownerBalance.balanceUsdMicros),
          lifetimeGrantedUsdMicros: ownerBalance.lifetimeGrantedUsdMicros,
          consumedUsdMicros: ownerBalance.consumedUsdMicros,
        }
      : null,
    paymentMethod: {
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
