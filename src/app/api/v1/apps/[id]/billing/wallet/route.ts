import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { loadBillingState } from "@/lib/billing/billing-state-read";
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
    const endUserId = billingTarget.target.externalUserId;
    const [trialBalance, paymentMethods, usagePlanRows, billingState] =
      await Promise.all([
        getTrialCreditBalance({
          clientId,
          externalUserId: endUserId,
        }),
        listAppUserPaymentMethods({
          clientId: access.app.id,
          externalUserId: endUserId,
        }).catch(() => null),
        usagePlanRowsPromise,
        loadBillingState({
          publicClientId: clientId,
          appId: access.app.id,
          target: billingTarget.target,
          externalUserId: endUserId,
        }),
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
        hasDefault: paymentMethods
          ? paymentMethods.some((pm) => pm.isDefault)
          : null,
      },
      billingState,
      payPerUsePlans: usagePlanRows.map((usagePlan) => ({
        planId: usagePlan.id,
        planName: usagePlan.name,
        chargeThresholdUsdMicros: usagePlan.chargeThresholdUsdMicros ?? null,
        resolvedBehavior: resolvedPayPerUseBehavior(),
      })),
    });
  }

  const [ownerBalance, hasDefaultPaymentMethod, usagePlanRows, billingState] =
    await Promise.all([
      getOwnerPrepaidCreditBalance(billingTarget.target.ownerUserId),
      ownerHasChargeablePaymentMethod(billingTarget.target.ownerUserId),
      usagePlanRowsPromise,
      loadBillingState({
        publicClientId: clientId,
        appId: access.app.id,
        target: billingTarget.target,
        externalUserId,
      }),
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
    billingState,
    payPerUsePlans: usagePlanRows.map((usagePlan) => ({
      planId: usagePlan.id,
      planName: usagePlan.name,
      chargeThresholdUsdMicros: usagePlan.chargeThresholdUsdMicros ?? null,
      resolvedBehavior: resolvedPayPerUseBehavior(),
    })),
  });
}

/**
 * PATCH /api/v1/apps/{clientId}/billing/wallet — per-user auto top-up prefs
 * are retired. Soft-negative is configured via PATCH …/billing/stripe.
 */
export async function PATCH() {
  return NextResponse.json(
    {
      error:
        "Per-user auto top-up is retired. Configure softNegativeUsdMicros via PATCH /api/v1/apps/{clientId}/billing/stripe; mid-cycle charges use OpenMeter progressive invoicing.",
      code: "auto_topup_retired",
    },
    { status: 410 },
  );
}
