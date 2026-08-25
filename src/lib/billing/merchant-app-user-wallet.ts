import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { loadBillingState } from "@/lib/billing/billing-state-read";
import {
  formatUsdMicrosForDisplay,
  resolvedPayPerUseBehavior,
} from "@/lib/billing/pay-per-use-threshold";
import { listAppUserPaymentMethods } from "@/lib/openmeter/app-user-payment-method";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { loadAppUserAutoTopUpPrefs } from "@/lib/stripe/auto-topup";

/** Merchant prepaid wallet JSON for an app end-user. */
export async function loadMerchantAppUserWallet(input: {
  publicClientId: string;
  appId: string;
  externalUserId: string;
}): Promise<Response> {
  const endUserId = input.externalUserId;
  const usagePlanRowsPromise = db
    .select({
      id: plans.id,
      name: plans.name,
      chargeThresholdUsdMicros: plans.chargeThresholdUsdMicros,
    })
    .from(plans)
    .where(
      and(
        eq(plans.clientId, input.appId),
        eq(plans.type, "usage"),
        eq(plans.status, "active"),
      ),
    )
    .orderBy(desc(plans.updatedAt));

  const [trialBalance, paymentMethods, usagePlanRows, billingState, autoTopUp] =
    await Promise.all([
      getTrialCreditBalance({
        clientId: input.publicClientId,
        externalUserId: endUserId,
      }).catch(() => null),
      listAppUserPaymentMethods({
        clientId: input.appId,
        externalUserId: endUserId,
      }).catch(() => null),
      usagePlanRowsPromise,
      loadBillingState({
        publicClientId: input.publicClientId,
        appId: input.appId,
        target: { mode: "merchant", externalUserId: endUserId },
        externalUserId: endUserId,
      }).catch(() => null),
      loadAppUserAutoTopUpPrefs({
        appId: input.appId,
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
    clientId: input.publicClientId,
    balance,
    paymentMethod: {
      hasDefault: paymentMethods
        ? paymentMethods.some((pm) => pm.isDefault)
        : null,
    },
    autoTopUp,
    billingState,
    payPerUsePlans: usagePlanRows.map((usagePlan) => ({
      planId: usagePlan.id,
      planName: usagePlan.name,
      chargeThresholdUsdMicros: usagePlan.chargeThresholdUsdMicros ?? null,
      resolvedBehavior: resolvedPayPerUseBehavior(),
    })),
  });
}
