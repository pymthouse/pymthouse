import type { OpenMeter } from "@openmeter/sdk";

import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import { resolvePlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { prepareOwnerCustomerStripeBilling } from "./billing-profiles";
import {
  DEFAULT_TRIAL_FEATURE_KEY,
  getHostedOpenMeterUrl,
} from "./constants";
import { ensureOwnerCustomer, listOwnedPublicClientIds } from "./customers";
import {
  ensureKonnectTenantCatalog,
  findKonnectFeatureIdByKey,
} from "./konnect-catalog";
import { changeKonnectSubscription } from "./konnect-subscriptions";
import {
  createOwnerAllowancePlan,
  findOpenMeterPlanByKey,
  forceSyncOwnerAllowancePlan,
  openMeterPlanNeedsPublish,
  publishOpenMeterPlanBestEffort,
  readUsageDiscountUsdMicrosFromPlanBody,
} from "./owner-allowance-plan";
import { isOpenMeterPlanNotFoundError } from "./plan-errors";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  listOpenMeterSubscriptionsForCustomer,
  verifyOpenMeterSubscriptionId,
} from "./subscription-read";
import { isOwnerStarterPlanKey } from "./owner-starter-key";
import {
  OWNER_PAID_PLAN_KEY,
  OWNER_PAID_PLAN_NAME,
  isOwnerPaidPlanKey,
} from "./owner-paid-key";
import { ownerHasChargeablePaymentMethod } from "./owner-payment-method";

export {
  OWNER_PAID_PLAN_KEY,
  OWNER_PAID_PLAN_NAME,
  isOwnerPaidPlanKey,
} from "./owner-paid-key";

export type OwnerPaidPlanRef = {
  key: string;
  openmeterPlanId: string;
  includedUsdMicros: string;
};

const OWNER_PAID_PLAN_CACHE_KEY = "owner-paid-plan";

let ownerPaidPlanCache: ReturnType<
  typeof createAsyncTtlCache<OwnerPaidPlanRef>
> | null = null;

function getOwnerPaidPlanCache() {
  ownerPaidPlanCache ??= createAsyncTtlCache<OwnerPaidPlanRef>({
    ttlSeconds: resolveCacheTtlSeconds("OWNER_PAID_PLAN_CACHE_TTL_SECONDS", 600),
  });
  return ownerPaidPlanCache;
}

export function resetOwnerPaidPlanCacheForTests(): void {
  ownerPaidPlanCache = null;
}

export function invalidateOwnerPaidPlanCache(): void {
  ownerPaidPlanCache = null;
}

/**
 * Force-update (or create) the fixed-key Owner Paid plan and publish it.
 * Used when the platform Developer default changes so discounts.usage is rewritten.
 */
export async function forceSyncOwnerPaidPlan(
  includedUsdMicros: string,
): Promise<OwnerPaidPlanRef> {
  const synced = await forceSyncOwnerAllowancePlan({
    planKey: OWNER_PAID_PLAN_KEY,
    planName: OWNER_PAID_PLAN_NAME,
    planKind: "owner_paid",
    includedUsdMicros,
    warnLabel: "owner paid",
  });

  invalidateOwnerPaidPlanCache();
  const ref: OwnerPaidPlanRef = {
    key: synced.key,
    openmeterPlanId: synced.openmeterPlanId,
    includedUsdMicros: synced.includedUsdMicros,
  };
  getOwnerPaidPlanCache().seed(OWNER_PAID_PLAN_CACHE_KEY, ref);
  return ref;
}

/**
 * Read-only peek at the published Owner Paid plan (no force-sync side effects).
 * Used by admin GET so drift is visible without mutating OpenMeter.
 */
export async function peekOwnerPaidPlanPublished(): Promise<{
  planKey: string;
  openmeterPlanId: string | null;
  publishedIncludedUsdMicros: string | null;
}> {
  const planKey = OWNER_PAID_PLAN_KEY;
  if (!isHostedAdminClientAvailable()) {
    return {
      planKey,
      openmeterPlanId: null,
      publishedIncludedUsdMicros: null,
    };
  }

  try {
    const client = getHostedAdminClient();
    const existing = await findOpenMeterPlanByKey(client, planKey);
    if (!existing?.id) {
      return {
        planKey,
        openmeterPlanId: null,
        publishedIncludedUsdMicros: null,
      };
    }
    const body = await client.plans.get(existing.id);
    return {
      planKey,
      openmeterPlanId: existing.id,
      publishedIncludedUsdMicros: readUsageDiscountUsdMicrosFromPlanBody(body),
    };
  } catch {
    return {
      planKey,
      openmeterPlanId: null,
      publishedIncludedUsdMicros: null,
    };
  }
}

/**
 * Ensure the platform Owner Paid plan exists and its published discount matches
 * the current Developer platform default. Settlement collects via the owners
 * Stripe billing profile.
 */
export async function ensureOwnerPaidPlanSynced(): Promise<OwnerPaidPlanRef> {
  return getOwnerPaidPlanCache().get(
    OWNER_PAID_PLAN_CACHE_KEY,
    () => ensureOwnerPaidPlanSyncedUncached(),
  );
}

async function ensureOwnerPaidPlanSyncedUncached(): Promise<OwnerPaidPlanRef> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }

  const amount = (await resolvePlatformOwnerStarterIncludedUsdMicros()).trim();
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  const useKonnect = shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey);
  if (!useKonnect) {
    throw new Error("Owner Paid plan requires Konnect metering routes");
  }

  const client = getHostedAdminClient();
  await ensureKonnectTenantCatalog();
  const featureId = await findKonnectFeatureIdByKey(DEFAULT_TRIAL_FEATURE_KEY);
  if (!featureId) {
    throw new Error(`Konnect feature missing: ${DEFAULT_TRIAL_FEATURE_KEY}`);
  }

  const existing = await findOpenMeterPlanByKey(client, OWNER_PAID_PLAN_KEY);
  if (existing?.id) {
    let publishedMicros: string | null = null;
    try {
      const body = await client.plans.get(existing.id);
      publishedMicros = readUsageDiscountUsdMicrosFromPlanBody(body);
    } catch {
      publishedMicros = null;
    }

    if (publishedMicros === amount) {
      if (openMeterPlanNeedsPublish(existing.status)) {
        await publishOpenMeterPlanBestEffort(client, existing.id, "owner paid");
      }
      return {
        key: OWNER_PAID_PLAN_KEY,
        openmeterPlanId: existing.id,
        includedUsdMicros: publishedMicros,
      };
    }

    // Published discount drifted from the platform default — rewrite.
    return forceSyncOwnerPaidPlan(amount);
  }

  let openmeterPlanId = await createOwnerAllowancePlan({
    client,
    planKey: OWNER_PAID_PLAN_KEY,
    planName: OWNER_PAID_PLAN_NAME,
    planKind: "owner_paid",
    featureId,
    includedUsdMicros: amount,
    createFailedMessage: "Failed to create Owner Paid plan",
  });
  openmeterPlanId = await publishOpenMeterPlanBestEffort(
    client,
    openmeterPlanId,
    "owner paid",
  );

  return {
    key: OWNER_PAID_PLAN_KEY,
    openmeterPlanId,
    includedUsdMicros: amount,
  };
}

async function findActiveOwnerWalletSubscription(input: {
  client: OpenMeter;
  customerId: string;
  hintOpenMeterSubscriptionId?: string | null;
}): Promise<{
  id: string;
  planKey: string;
  openmeterPlanId: string;
} | null> {
  if (input.hintOpenMeterSubscriptionId) {
    const verified = await verifyOpenMeterSubscriptionId(
      input.client,
      input.hintOpenMeterSubscriptionId,
    );
    if (
      verified?.id &&
      verified.customerId &&
      verified.customerId === input.customerId
    ) {
      return {
        id: verified.id,
        planKey: verified.planKey ?? "",
        openmeterPlanId: verified.planId ?? "",
      };
    }
  }

  try {
    const listed = await listOpenMeterSubscriptionsForCustomer(
      input.client,
      input.customerId,
    );
    const active = listed.find(
      (s) =>
        s.status === "active" ||
        s.status === "trialing" ||
        s.status === "scheduled" ||
        s.status === "pending" ||
        !s.status,
    );
    if (!active?.id) {
      return null;
    }
    return {
      id: active.id,
      planKey: active.planKey ?? "",
      openmeterPlanId: active.planId ?? "",
    };
  } catch {
    return null;
  }
}

export class OwnerPaidUpgradeError extends Error {
  readonly code:
    | "payment_method_required"
    | "openmeter_unavailable"
    | "no_subscription"
    | "upgrade_failed";

  constructor(
    code: OwnerPaidUpgradeError["code"],
    message: string,
  ) {
    super(message);
    this.name = "OwnerPaidUpgradeError";
    this.code = code;
  }
}

/**
 * Upgrade an owner wallet from Sandbox Starter to Owner Paid.
 * Requires a chargeable default payment method; pins the owners Stripe
 * profile, then changes the Konnect subscription.
 */
export async function upgradeOwnerToPaidPlan(input: {
  ownerUserId: string;
  hintOpenMeterSubscriptionId?: string | null;
}): Promise<{
  openmeterSubscriptionId: string;
  planKey: string;
  openmeterPlanId: string;
  alreadyPaid: boolean;
}> {
  if (!isHostedAdminClientAvailable()) {
    throw new OwnerPaidUpgradeError(
      "openmeter_unavailable",
      "OpenMeter is not configured",
    );
  }

  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) {
    throw new OwnerPaidUpgradeError(
      "upgrade_failed",
      "ownerUserId is required",
    );
  }

  const chargeable = await ownerHasChargeablePaymentMethod(ownerUserId);
  if (chargeable !== true) {
    throw new OwnerPaidUpgradeError(
      "payment_method_required",
      "Add a payment method before upgrading to Owner Paid",
    );
  }

  const plan = await ensureOwnerPaidPlanSynced();
  const client = getHostedAdminClient();
  const publicClientIds = await listOwnedPublicClientIds(ownerUserId);
  const customer = await ensureOwnerCustomer(
    client,
    ownerUserId,
    publicClientIds,
  );

  // Ensure cus_… + owners Stripe profile before the Paid subscription change.
  await prepareOwnerCustomerStripeBilling({
    client,
    customerId: customer.id,
    customerKey: customer.key,
  });

  const existing = await findActiveOwnerWalletSubscription({
    client,
    customerId: customer.id,
    hintOpenMeterSubscriptionId: input.hintOpenMeterSubscriptionId,
  });

  if (!existing?.id) {
    throw new OwnerPaidUpgradeError(
      "no_subscription",
      "No active owner wallet subscription to upgrade",
    );
  }

  if (isOwnerPaidPlanKey(existing.planKey)) {
    return {
      openmeterSubscriptionId: existing.id,
      planKey: existing.planKey || plan.key,
      openmeterPlanId: existing.openmeterPlanId || plan.openmeterPlanId,
      alreadyPaid: true,
    };
  }

  if (
    existing.planKey &&
    !isOwnerStarterPlanKey(existing.planKey) &&
    !isOwnerPaidPlanKey(existing.planKey)
  ) {
    throw new OwnerPaidUpgradeError(
      "upgrade_failed",
      `Cannot upgrade subscription on plan ${existing.planKey} to Owner Paid`,
    );
  }

  try {
    await changeKonnectSubscription({
      subscriptionId: existing.id,
      customerId: customer.id,
      planId: plan.openmeterPlanId,
      timing: "immediate",
    });
  } catch (err) {
    if (isOpenMeterPlanNotFoundError(err)) {
      invalidateOwnerPaidPlanCache();
      const resynced = await ensureOwnerPaidPlanSynced();
      await changeKonnectSubscription({
        subscriptionId: existing.id,
        customerId: customer.id,
        planId: resynced.openmeterPlanId,
        timing: "immediate",
      });
      return {
        openmeterSubscriptionId: existing.id,
        planKey: resynced.key,
        openmeterPlanId: resynced.openmeterPlanId,
        alreadyPaid: false,
      };
    }
    console.error("Owner Paid upgrade change failed", err);
    throw new OwnerPaidUpgradeError(
      "upgrade_failed",
      "Owner Paid upgrade failed",
    );
  }

  return {
    openmeterSubscriptionId: existing.id,
    planKey: plan.key,
    openmeterPlanId: plan.openmeterPlanId,
    alreadyPaid: false,
  };
}

/**
 * True when the owner wallet is on Owner Paid with a chargeable payment method
 * so mint/signer may continue past spendable=0 (overage invoices).
 */
export async function ownerWalletAllowsOverageInvoicing(
  ownerUserId: string,
): Promise<boolean> {
  const trimmed = ownerUserId.trim();
  if (!trimmed || !isHostedAdminClientAvailable()) {
    return false;
  }

  const chargeable = await ownerHasChargeablePaymentMethod(trimmed);
  if (chargeable !== true) {
    return false;
  }

  try {
    const client = getHostedAdminClient();
    const publicClientIds = await listOwnedPublicClientIds(trimmed);
    const customer = await ensureOwnerCustomer(
      client,
      trimmed,
      publicClientIds,
    );
    const existing = await findActiveOwnerWalletSubscription({
      client,
      customerId: customer.id,
    });
    return isOwnerPaidPlanKey(existing?.planKey);
  } catch {
    return false;
  }
}
