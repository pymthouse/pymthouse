/**
 * Load the canonical billing state for a subject.
 *
 * Server-only companion to `billing-state.ts`: gathers prepaid credits, plan
 * discount, overage eligibility and unbilled debt, then hands them to the pure
 * resolver so the wallet route, the state route and the collect route all
 * report identical posture.
 */
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import {
  effectiveInvoiceLeadUsdMicros,
  effectiveSoftNegativeUsdMicros,
  MIN_INVOICE_USD_MICROS,
} from "@/lib/billing/overage-limits";
import {
  type BillingState,
  resolveBillingState,
} from "@/lib/billing/billing-state";
import { resolveAllowsOverageInvoicing } from "@/lib/billing/overage-invoicing";
import { getUnbilledDebtDetails } from "@/lib/billing/unbilled-debt";
import type { WalletBillingTarget } from "@/lib/billing/wallet-billing-target";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import { COLLECTION_INTERVAL } from "@/lib/openmeter/billing-collection";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { ownerHasChargeablePaymentMethod } from "@/lib/openmeter/owner-payment-method";
import {
  appUserHasChargeablePaymentMethod,
  listAppUserPaymentMethods,
} from "@/lib/openmeter/app-user-payment-method";
import {
  getPlanDiscountUsdMicros,
} from "@/lib/openmeter/spendable-allowance";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  resolveLocalPlanIdFromOpenMeterSubscription,
} from "@/lib/openmeter/subscription-read";
import { resolveAppUserSubscriptionPlanName } from "@/lib/billing/app-user-subscription-display";
import { isOwnerStarterPlanKey } from "@/lib/openmeter/owner-starter-key";

/** OM plans carry a nominal monthly cadence; see pay-per-use-threshold.ts. */
const DEFAULT_BILLING_CYCLE = "P1M";

function toBigInt(value: string | null | undefined): bigint {
  if (!value?.trim()) return 0n;
  try {
    const parsed = BigInt(value.trim());
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

async function resolveIncludedSourcePlan(input: {
  appId: string;
  publicClientId: string;
  externalUserId: string;
}): Promise<{
  id: string | null;
  name: string | null;
  type: string | null;
} | null> {
  const live = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: input.publicClientId,
    externalUserId: input.externalUserId,
  }).catch(() => null);
  if (!live) return null;

  const localPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    input.appId,
    live,
  ).catch(() => null);
  const plan = localPlanId
    ? (
        await db
          .select({
            id: plans.id,
            name: plans.name,
            type: plans.type,
            isStarterDefault: plans.isStarterDefault,
          })
          .from(plans)
          .where(eq(plans.id, localPlanId))
          .limit(1)
      )[0]
    : null;
  const isOwnerStarter = isOwnerStarterPlanKey(live.planKey);
  return {
    id: plan?.id ?? null,
    name: resolveAppUserSubscriptionPlanName({
      plan: plan
        ? {
            id: plan.id,
            name: plan.name,
            type: plan.type,
            status: "active",
            phaseOutAt: null,
            replacementPlanId: null,
            isStarterDefault: plan.isStarterDefault,
          }
        : null,
      planKey: live.planKey,
    }),
    type: plan?.type ?? (isOwnerStarter ? "free" : null),
  };
}

async function merchantFunding(input: {
  publicClientId: string;
  appId: string;
  externalUserId: string;
}) {
  const [credits, discount, chargeable, paymentMethods, overageEligible, debt, sourcePlan] =
    await Promise.all([
      getTrialCreditBalance({
        clientId: input.publicClientId,
        externalUserId: input.externalUserId,
      }).catch(() => null),
      getPlanDiscountUsdMicros({
        clientId: input.publicClientId,
        externalUserId: input.externalUserId,
      }).catch(() => ({ totalUsdMicros: 0n, remainingUsdMicros: 0n })),
      appUserHasChargeablePaymentMethod({
        clientId: input.appId,
        externalUserId: input.externalUserId,
      }).catch(() => null),
      listAppUserPaymentMethods({
        clientId: input.appId,
        externalUserId: input.externalUserId,
      }).catch(() => null),
      resolveAllowsOverageInvoicing({
        clientId: input.publicClientId,
        externalUserId: input.externalUserId,
      }).catch(() => false),
      getUnbilledDebtDetails({
        clientId: input.publicClientId,
        externalUserId: input.externalUserId,
      }).catch(() => null),
      resolveIncludedSourcePlan({
        appId: input.appId,
        publicClientId: input.publicClientId,
        externalUserId: input.externalUserId,
      }),
    ]);

  const defaultMethod = paymentMethods?.find((pm) => pm.isDefault) ?? null;
  // Same chargeability predicate the mint/signer overage gate uses — display
  // must not disagree with `overage.eligible` / 483 reason.
  const hasDefault =
    chargeable === true
      ? true
      : chargeable === false
        ? false
        : paymentMethods
          ? Boolean(defaultMethod)
          : null;

  return {
    prepaidUsdMicros: toBigInt(credits?.balanceUsdMicros),
    includedTotalUsdMicros: discount.totalUsdMicros,
    includedRemainingUsdMicros: discount.remainingUsdMicros,
    includedSourcePlan: sourcePlan,
    overageEligible,
    paymentMethod: {
      hasDefault,
      brand: defaultMethod?.brand ?? null,
      last4: defaultMethod?.last4 ?? null,
    },
    debt,
  };
}

async function ownerFunding(input: {
  publicClientId: string;
  ownerUserId: string;
  externalUserId: string | null;
  appId: string;
}) {
  const [ownerBalance, hasDefault, debt] = await Promise.all([
    getOwnerPrepaidCreditBalance(input.ownerUserId).catch(() => null),
    ownerHasChargeablePaymentMethod(input.ownerUserId).catch(() => null),
    input.externalUserId
      ? getUnbilledDebtDetails({
          clientId: input.publicClientId,
          externalUserId: input.externalUserId,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const discount = input.externalUserId
    ? await getPlanDiscountUsdMicros({
        clientId: input.publicClientId,
        externalUserId: input.externalUserId,
      }).catch(() => ({ totalUsdMicros: 0n, remainingUsdMicros: 0n }))
    : { totalUsdMicros: 0n, remainingUsdMicros: 0n };

  const sourcePlan =
    input.externalUserId
      ? await resolveIncludedSourcePlan({
          appId: input.appId,
          publicClientId: input.publicClientId,
          externalUserId: input.externalUserId,
        })
      : null;

  return {
    prepaidUsdMicros: toBigInt(ownerBalance?.balanceUsdMicros),
    includedTotalUsdMicros: discount.totalUsdMicros,
    includedRemainingUsdMicros: discount.remainingUsdMicros,
    includedSourcePlan: sourcePlan,
    // Owner overage rides on a chargeable payment method plus a paid plan;
    // without a subject we can only observe the payment method half.
    overageEligible: input.externalUserId
      ? await resolveAllowsOverageInvoicing({
          clientId: input.publicClientId,
          externalUserId: input.externalUserId,
        }).catch(() => false)
      : hasDefault === true,
    paymentMethod: { hasDefault, brand: null, last4: null },
    debt,
  };
}

export async function loadBillingState(input: {
  /** Public OAuth client id, as used on the wire. */
  publicClientId: string;
  /** `developer_apps.id`. */
  appId: string;
  target: WalletBillingTarget;
  /** Present for merchant targets, and optionally for owner rollup reads. */
  externalUserId: string | null;
  lastRaisedAt?: string | null;
  nextRaiseEligibleAt?: string | null;
}): Promise<BillingState> {
  const billingConfig = await getAppBillingConfig(input.appId);
  const target = input.target;
  const merchant = target.mode === "merchant";
  const subjectId = merchant ? target.externalUserId : input.externalUserId;

  const funding =
    target.mode === "merchant"
      ? await merchantFunding({
          publicClientId: input.publicClientId,
          appId: input.appId,
          externalUserId: target.externalUserId,
        })
      : await ownerFunding({
          publicClientId: input.publicClientId,
          ownerUserId: target.ownerUserId,
          externalUserId: input.externalUserId,
          appId: input.appId,
        });

  const softNegativeUsdMicros = effectiveSoftNegativeUsdMicros(
    billingConfig?.softNegativeUsdMicros,
  );

  const cycle = calendarMonthBoundsUtc(new Date());

  return resolveBillingState({
    currency: billingConfig?.defaultCurrency?.trim() || "USD",
    subject: {
      type: merchant ? "end_user" : "owner",
      externalUserId: subjectId,
      billingMode: merchant ? "merchant" : "owner_rollup",
    },
    prepaidUsdMicros: funding.prepaidUsdMicros,
    includedRemainingUsdMicros: funding.includedRemainingUsdMicros,
    includedTotalUsdMicros: funding.includedTotalUsdMicros,
    includedResetsAt: cycle.end,
    includedSourcePlan: funding.includedSourcePlan,
    overageEligible: funding.overageEligible,
    softNegativeUsdMicros,
    unbilledDebtUsdMicros: funding.debt?.usdMicros ?? null,
    debtSource: funding.debt?.source ?? "unavailable",
    leadUsdMicros: effectiveInvoiceLeadUsdMicros({
      storedUsdMicros: billingConfig?.invoiceLeadUsdMicros,
      softNegativeUsdMicros,
    }),
    minimumChargeUsdMicros: MIN_INVOICE_USD_MICROS,
    collector: merchant ? "settlement_connect" : "openmeter_stripe",
    paymentMethod: funding.paymentMethod,
    billingAvailable: isHostedAdminClientAvailable(),
    cycle: DEFAULT_BILLING_CYCLE,
    collectionInterval: COLLECTION_INTERVAL,
    lastRaisedAt: input.lastRaisedAt ?? null,
    nextRaiseEligibleAt: input.nextRaiseEligibleAt ?? null,
  });
}
