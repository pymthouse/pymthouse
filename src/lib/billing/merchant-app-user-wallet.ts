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

/**
 * Merchant prepaid wallet JSON for an app end-user. OpenMeter / Stripe reads
 * fail open so prefs and plans still render, but `degraded: true` marks the
 * response — a null `balance` then means "unknown", not "no credit".
 */
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

  let degraded = false;
  const failOpen = <T>(read: Promise<T>, label: string): Promise<T | null> =>
    read.catch((err: unknown) => {
      degraded = true;
      console.warn(
        `merchant-wallet: ${label} unavailable`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    });

  const [trialBalance, paymentMethods, usagePlanRows, billingState, autoTopUp] =
    await Promise.all([
      failOpen(
        getTrialCreditBalance({
          clientId: input.publicClientId,
          externalUserId: endUserId,
        }),
        "balance",
      ),
      failOpen(
        listAppUserPaymentMethods({
          clientId: input.appId,
          externalUserId: endUserId,
        }),
        "payment methods",
      ),
      usagePlanRowsPromise,
      failOpen(
        loadBillingState({
          publicClientId: input.publicClientId,
          appId: input.appId,
          target: { mode: "merchant", externalUserId: endUserId },
          externalUserId: endUserId,
        }),
        "billing state",
      ),
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
    degraded,
    payPerUsePlans: usagePlanRows.map((usagePlan) => ({
      planId: usagePlan.id,
      planName: usagePlan.name,
      chargeThresholdUsdMicros: usagePlan.chargeThresholdUsdMicros ?? null,
      resolvedBehavior: resolvedPayPerUseBehavior(),
    })),
  });
}
