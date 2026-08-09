/**
 * Load the canonical billing state for a subject.
 *
 * Server-only companion to `billing-state.ts`: gathers prepaid credits, plan
 * discount, overage eligibility and unbilled debt, then hands them to the pure
 * resolver so the wallet route, the state route and the collect route all
 * report identical posture.
 */
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
import { COLLECTION_INTERVAL } from "@/lib/openmeter/billing-collection";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { ownerHasChargeablePaymentMethod } from "@/lib/openmeter/owner-payment-method";
import { listAppUserPaymentMethods } from "@/lib/openmeter/app-user-payment-method";
import { getRemainingPlanDiscountUsdMicros } from "@/lib/openmeter/spendable-allowance";

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

async function merchantFunding(input: {
  publicClientId: string;
  appId: string;
  externalUserId: string;
}) {
  const [credits, includedRemaining, paymentMethods, overageEligible, debt] =
    await Promise.all([
      getTrialCreditBalance({
        clientId: input.publicClientId,
        externalUserId: input.externalUserId,
      }).catch(() => null),
      getRemainingPlanDiscountUsdMicros({
        clientId: input.publicClientId,
        externalUserId: input.externalUserId,
      }).catch(() => 0n),
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
    ]);

  const defaultMethod = paymentMethods?.find((pm) => pm.isDefault) ?? null;
  return {
    prepaidUsdMicros: toBigInt(credits?.balanceUsdMicros),
    includedRemainingUsdMicros: includedRemaining,
    overageEligible,
    paymentMethod: {
      hasDefault: paymentMethods ? Boolean(defaultMethod) : null,
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

  const includedRemaining = input.externalUserId
    ? await getRemainingPlanDiscountUsdMicros({
        clientId: input.publicClientId,
        externalUserId: input.externalUserId,
      }).catch(() => 0n)
    : 0n;

  return {
    prepaidUsdMicros: toBigInt(ownerBalance?.balanceUsdMicros),
    includedRemainingUsdMicros: includedRemaining,
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
        });

  const softNegativeUsdMicros = effectiveSoftNegativeUsdMicros(
    billingConfig?.softNegativeUsdMicros,
  );

  return resolveBillingState({
    currency: billingConfig?.defaultCurrency?.trim() || "USD",
    subject: {
      type: merchant ? "end_user" : "owner",
      externalUserId: subjectId,
      billingMode: merchant ? "merchant" : "owner_rollup",
    },
    prepaidUsdMicros: funding.prepaidUsdMicros,
    includedRemainingUsdMicros: funding.includedRemainingUsdMicros,
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
