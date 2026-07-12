import { hasPositiveUsdMicrosBalance } from "@/lib/format-usd-micros";
import { isHostedAdminClientAvailable } from "./admin-client";
import {
  getHostedTrialOpenMeterClient,
  getTrialFeatureKeyForApp,
} from "./client-factory";
import { getHostedOpenMeterUrl } from "./constants";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { ensureOpenMeterCustomer } from "./customers";
import {
  getTrialCreditBalance,
  type TrialCreditBalance,
} from "./entitlements";
import { getKonnectEntitlementHasAccess } from "./konnect-entitlements";
import { shouldUseKonnectRoutes } from "./route-mode";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { buildOpenMeterPlanKey } from "./plans-sync";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  type OpenMeterSubscriptionView,
} from "./subscription-read";

export type MintAllowanceGateCode = "billing_unavailable" | "trial_credits_exhausted";

export type MintAllowanceGateDenial = {
  code: MintAllowanceGateCode;
  message: string;
};

export type AllowanceAccessSnapshot = {
  allowance: TrialCreditBalance | null;
  hasPaidSubscription: boolean;
  /** Konnect plan-attached included usage still available (entitlement-access). */
  hasPlanIncludedAccess: boolean;
};

function isStarterSubscription(
  subscription: OpenMeterSubscriptionView,
  starterPlanKey: string,
  starterOpenMeterPlanId: string | null,
): boolean {
  if (subscription.planKey === starterPlanKey) {
    return true;
  }
  if (starterOpenMeterPlanId && subscription.planId === starterOpenMeterPlanId) {
    return true;
  }
  return false;
}

/** True when the user's primary active OpenMeter subscription is a non-Starter plan. */
export async function hasActivePaidOpenMeterSubscriptionForAppUser(input: {
  clientId: string;
  externalUserId: string;
}): Promise<boolean> {
  if (!isHostedAdminClientAvailable()) {
    return false;
  }
  const primary = await getPrimaryOpenMeterSubscriptionForAppUser(input);
  if (!primary) {
    return false;
  }
  const starter = await getOrCreateStarterPlan(input.clientId);
  const starterPlanKey = buildOpenMeterPlanKey(input.clientId, starter.id);
  return !isStarterSubscription(primary, starterPlanKey, starter.openmeterPlanId);
}

/**
 * Konnect plan-attached monthly included usage (discounts.usage) may not appear on
 * the credits ledger. Fall back to entitlement-access for the trial feature.
 */
export async function getKonnectPlanIncludedAccess(input: {
  clientId: string;
  externalUserId: string;
  featureKey?: string;
}): Promise<boolean> {
  const client = getHostedTrialOpenMeterClient();
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!client || !shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey)) {
    return false;
  }
  const customerKey = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
  const customer = await ensureOpenMeterCustomer(client, customerKey);
  const featureKey =
    input.featureKey?.trim() || (await getTrialFeatureKeyForApp(input.clientId));
  const access = await getKonnectEntitlementHasAccess({
    customerId: customer.id,
    featureKey,
    apiKey,
  });
  return access === true;
}

export async function resolveAllowanceAccessForAppUser(input: {
  clientId: string;
  externalUserId: string;
  allowance?: TrialCreditBalance | null;
}): Promise<AllowanceAccessSnapshot> {
  // Prefer an explicit allowance (including null = unreadable) over a fresh fetch.
  const allowance =
    input.allowance !== undefined
      ? input.allowance
      : await getTrialCreditBalance({
          clientId: input.clientId,
          externalUserId: input.externalUserId,
        });

  const hasPaidSubscription = await hasActivePaidOpenMeterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

  let hasPlanIncludedAccess = false;
  if (
    !hasPaidSubscription &&
    !hasPositiveUsdMicrosBalance(allowance?.balanceUsdMicros)
  ) {
    hasPlanIncludedAccess = await getKonnectPlanIncludedAccess({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });
  }

  return {
    allowance,
    hasPaidSubscription,
    hasPlanIncludedAccess,
  };
}

/**
 * Decide whether mint/sign is allowed.
 * - Paid (non-Starter) subscription: allow (overage invoices).
 * - Positive remaining credit / entitlement micros: allow.
 * - Konnect plan-included entitlement access: allow.
 * - Starter with nothing remaining: block.
 */
export function mintAllowanceGateDecision(
  snapshot: AllowanceAccessSnapshot | TrialCreditBalance | null,
  hostedBillingEnabled: boolean,
  options?: {
    hasPaidSubscription?: boolean;
    hasPlanIncludedAccess?: boolean;
  },
): MintAllowanceGateDenial | null {
  if (!hostedBillingEnabled) {
    return null;
  }

  const normalized: AllowanceAccessSnapshot =
    snapshot != null && "hasPaidSubscription" in snapshot
      ? snapshot
      : {
          allowance: snapshot as TrialCreditBalance | null,
          hasPaidSubscription: options?.hasPaidSubscription === true,
          hasPlanIncludedAccess: options?.hasPlanIncludedAccess === true,
        };

  if (normalized.hasPaidSubscription) {
    return null;
  }
  if (normalized.hasPlanIncludedAccess) {
    return null;
  }
  if (!normalized.allowance) {
    return {
      code: "billing_unavailable",
      message: "Billing allowance could not be confirmed",
    };
  }
  if (hasPositiveUsdMicrosBalance(normalized.allowance.balanceUsdMicros)) {
    return null;
  }
  return {
    code: "trial_credits_exhausted",
    message: "Starter included usage exhausted",
  };
}

/**
 * Balance micros for the signer webhook gate. Returns a positive sentinel when
 * access is allowed via paid subscription or plan-included entitlement without
 * a credits ledger balance; null when billing cannot be confirmed.
 */
export function effectiveBalanceUsdMicrosForGate(
  snapshot: AllowanceAccessSnapshot,
): string | null {
  if (snapshot.hasPaidSubscription || snapshot.hasPlanIncludedAccess) {
    if (hasPositiveUsdMicrosBalance(snapshot.allowance?.balanceUsdMicros)) {
      return snapshot.allowance!.balanceUsdMicros;
    }
    return "1";
  }
  if (!snapshot.allowance) {
    return null;
  }
  return snapshot.allowance.balanceUsdMicros;
}
