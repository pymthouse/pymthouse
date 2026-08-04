import type { OpenMeter } from "@openmeter/sdk";

import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import { resolveOwnerStarterIncludedUsdMicros } from "@/lib/billing/owner-billing-config";
import { resolvePlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";
import { defaultRetailRateUsd } from "@/lib/plan-pricing";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { applyFreeBillingProfileToCustomer } from "./billing-profiles";
import {
  DEFAULT_TRIAL_FEATURE_KEY,
  getHostedOpenMeterUrl,
} from "./constants";
import { ensureOwnerCustomer } from "./customers";
import {
  ensureKonnectTenantCatalog,
  findKonnectFeatureIdByKey,
} from "./konnect-catalog";
import { changeKonnectSubscription } from "./konnect-subscriptions";
import {
  buildOwnerAllowancePlanBody,
  createOwnerAllowancePlan,
  findOpenMeterPlanByKey,
  openMeterPlanNeedsPublish,
  parseOwnerAllowanceIncludedMicros,
  publishOpenMeterPlanBestEffort,
} from "./owner-allowance-plan";
import {
  isOpenMeterConflictError,
  isOpenMeterPlanImmutableError,
  isOpenMeterPlanNotFoundError,
  isOpenMeterStripeBillingError,
} from "./plan-errors";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  findOpenMeterSubscriptionByPlanKey,
  listOpenMeterSubscriptionsForCustomer,
  verifyOpenMeterSubscriptionId,
} from "./subscription-read";
import {
  OWNER_STARTER_PLAN_KEY,
  OWNER_STARTER_PLAN_NAME,
  isOwnerStarterPlanKey,
  ownerStarterPlanKeyForAmount,
} from "./owner-starter-key";
import { isOwnerPaidPlanKey } from "./owner-paid-key";

export {
  OWNER_STARTER_PLAN_KEY,
  OWNER_STARTER_PLAN_NAME,
  isOwnerStarterPlanKey,
  ownerStarterIncludedUsdMicros,
  ownerStarterPlanKeyForAmount,
  isBaseOwnerStarterPlanKey,
} from "./owner-starter-key";

export type OwnerStarterPlanRef = {
  key: string;
  openmeterPlanId: string;
  includedUsdMicros: string;
};

let ownerStarterPlanCache: ReturnType<
  typeof createAsyncTtlCache<OwnerStarterPlanRef>
> | null = null;

function getOwnerStarterPlanCache() {
  ownerStarterPlanCache ??= createAsyncTtlCache<OwnerStarterPlanRef>({
    ttlSeconds: resolveCacheTtlSeconds("OWNER_STARTER_PLAN_CACHE_TTL_SECONDS", 600),
  });
  return ownerStarterPlanCache;
}

export function resetOwnerStarterPlanCacheForTests(): void {
  ownerStarterPlanCache = null;
}

/** Drop cached Owner Starter plan refs (call after platform default / override changes). */
export function invalidateOwnerStarterPlanCache(): void {
  ownerStarterPlanCache = null;
}

function cacheKeyForAmount(includedUsdMicros: string): string {
  return `owner-starter-plan:${includedUsdMicros}`;
}

/**
 * Ensure an Owner Starter plan exists for the given included allowance.
 * Amount-keyed: platform default → base key; overrides → `base_<micros>`.
 */
export async function ensureOwnerStarterPlanSynced(
  includedUsdMicros?: string,
): Promise<OwnerStarterPlanRef> {
  const platformDefault = await resolvePlatformOwnerStarterIncludedUsdMicros();
  const amount = (includedUsdMicros ?? platformDefault).trim();
  const planKey = ownerStarterPlanKeyForAmount(amount, platformDefault);

  return getOwnerStarterPlanCache().get(cacheKeyForAmount(amount), async () =>
    ensureOwnerStarterPlanSyncedUncached({
      includedUsdMicros: amount,
      planKey,
    }),
  );
}

async function ensureOwnerStarterPlanSyncedUncached(input: {
  includedUsdMicros: string;
  planKey: string;
}): Promise<OwnerStarterPlanRef> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }

  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  const useKonnect = shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey);
  if (!useKonnect) {
    throw new Error("Owner Starter plan requires Konnect metering routes");
  }

  const client = getHostedAdminClient();
  await ensureKonnectTenantCatalog();
  const featureId = await findKonnectFeatureIdByKey(DEFAULT_TRIAL_FEATURE_KEY);
  if (!featureId) {
    throw new Error(`Konnect feature missing: ${DEFAULT_TRIAL_FEATURE_KEY}`);
  }

  const existing = await findOpenMeterPlanByKey(client, input.planKey);
  if (existing?.id) {
    if (openMeterPlanNeedsPublish(existing.status)) {
      await publishOpenMeterPlanBestEffort(client, existing.id, "owner starter");
    }
    return {
      key: input.planKey,
      openmeterPlanId: existing.id,
      includedUsdMicros: input.includedUsdMicros,
    };
  }

  let openmeterPlanId = await createOwnerAllowancePlan({
    client,
    planKey: input.planKey,
    planName: OWNER_STARTER_PLAN_NAME,
    planKind: "owner_starter",
    featureId,
    includedUsdMicros: input.includedUsdMicros,
    createFailedMessage: "Failed to create Owner Starter plan",
  });
  openmeterPlanId = await publishOpenMeterPlanBestEffort(
    client,
    openmeterPlanId,
    "owner starter",
  );

  return {
    key: input.planKey,
    openmeterPlanId,
    includedUsdMicros: input.includedUsdMicros,
  };
}

/**
 * Force-update (or create) the Owner Starter plan for an amount and publish it.
 * Used when the platform default changes so base-key discounts.usage is rewritten.
 */
export async function forceSyncOwnerStarterPlan(
  includedUsdMicros: string,
): Promise<OwnerStarterPlanRef> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }

  const platformDefault = await resolvePlatformOwnerStarterIncludedUsdMicros();
  const amount = includedUsdMicros.trim();
  const planKey = ownerStarterPlanKeyForAmount(amount, platformDefault);

  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  const useKonnect = shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey);
  if (!useKonnect) {
    throw new Error("Owner Starter plan requires Konnect metering routes");
  }

  const client = getHostedAdminClient();
  await ensureKonnectTenantCatalog();
  const featureId = await findKonnectFeatureIdByKey(DEFAULT_TRIAL_FEATURE_KEY);
  if (!featureId) {
    throw new Error(`Konnect feature missing: ${DEFAULT_TRIAL_FEATURE_KEY}`);
  }

  const body = buildOwnerAllowancePlanBody({
    planKey,
    planName: OWNER_STARTER_PLAN_NAME,
    planKind: "owner_starter",
    featureId,
    includedUsdMicros: parseOwnerAllowanceIncludedMicros(amount),
    unitAmount: defaultRetailRateUsd(),
  });

  const existing = await findOpenMeterPlanByKey(client, planKey);
  let openmeterPlanId = existing?.id;

  if (openmeterPlanId) {
    try {
      const updated = await client.plans.update(
        openmeterPlanId,
        body as unknown as Parameters<OpenMeter["plans"]["update"]>[1],
      );
      openmeterPlanId = updated?.id ?? openmeterPlanId;
    } catch (updateErr) {
      if (
        !isOpenMeterPlanNotFoundError(updateErr) &&
        !isOpenMeterPlanImmutableError(updateErr)
      ) {
        throw updateErr;
      }
      // Published versions are immutable — create a new draft under the same key.
      openmeterPlanId = await createOwnerAllowancePlan({
        client,
        planKey,
        planName: OWNER_STARTER_PLAN_NAME,
        planKind: "owner_starter",
        featureId,
        includedUsdMicros: amount,
        createFailedMessage: "Failed to create Owner Starter plan",
      });
    }
  } else {
    openmeterPlanId = await createOwnerAllowancePlan({
      client,
      planKey,
      planName: OWNER_STARTER_PLAN_NAME,
      planKind: "owner_starter",
      featureId,
      includedUsdMicros: amount,
      createFailedMessage: "Failed to create Owner Starter plan",
    });
  }

  openmeterPlanId = await publishOpenMeterPlanBestEffort(
    client,
    openmeterPlanId,
    "owner starter",
  );
  invalidateOwnerStarterPlanCache();

  const ref: OwnerStarterPlanRef = {
    key: planKey,
    openmeterPlanId,
    includedUsdMicros: amount,
  };
  getOwnerStarterPlanCache().seed(cacheKeyForAmount(amount), ref);
  return ref;
}

async function findExistingOwnerWalletSubscription(input: {
  client: OpenMeter;
  customerId: string;
  planKey: string;
  openmeterPlanId: string;
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
    if (verified?.id) {
      return {
        id: verified.id,
        planKey: verified.planKey ?? input.planKey,
        openmeterPlanId: verified.planId ?? input.openmeterPlanId,
      };
    }
  }

  const existing = await findOpenMeterSubscriptionByPlanKey(
    input.client,
    input.customerId,
    input.planKey,
    { openmeterPlanId: input.openmeterPlanId },
  );
  if (existing?.id) {
    return {
      id: existing.id,
      planKey: existing.planKey ?? input.planKey,
      openmeterPlanId: existing.planId ?? input.openmeterPlanId,
    };
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
    if (isOwnerStarterPlanKey(active.planKey)) {
      return {
        id: active.id,
        planKey: active.planKey ?? input.planKey,
        openmeterPlanId: active.planId ?? input.openmeterPlanId,
      };
    }
    return {
      id: active.id,
      planKey: active.planKey ?? input.planKey,
      openmeterPlanId: active.planId ?? input.openmeterPlanId,
    };
  } catch {
    return null;
  }
}

/**
 * Subscribe the shared owner customer to the Owner Starter plan for their
 * resolved allowance (platform default or per-owner override).
 */
export async function ensureOwnerStarterSubscription(input: {
  ownerUserId: string;
  publicClientIds?: string[];
  hintOpenMeterSubscriptionId?: string | null;
}): Promise<{
  openmeterSubscriptionId: string | null;
  planKey: string;
  openmeterPlanId: string;
  created: boolean;
}> {
  if (!isHostedAdminClientAvailable()) {
    return {
      openmeterSubscriptionId: null,
      planKey: OWNER_STARTER_PLAN_KEY,
      openmeterPlanId: "",
      created: false,
    };
  }

  const includedUsdMicros = await resolveOwnerStarterIncludedUsdMicros(
    input.ownerUserId,
  );
  const plan = await ensureOwnerStarterPlanSynced(includedUsdMicros);
  const client = getHostedAdminClient();
  const customer = await ensureOwnerCustomer(
    client,
    input.ownerUserId,
    input.publicClientIds ?? [],
  );

  const existing = await findExistingOwnerWalletSubscription({
    client,
    customerId: customer.id,
    planKey: plan.key,
    openmeterPlanId: plan.openmeterPlanId,
    hintOpenMeterSubscriptionId: input.hintOpenMeterSubscriptionId,
  });

  if (existing) {
    // Already on Owner Paid — do not recreate Sandbox Starter or re-pin sandbox.
    if (isOwnerPaidPlanKey(existing.planKey)) {
      return {
        openmeterSubscriptionId: existing.id,
        planKey: existing.planKey,
        openmeterPlanId: existing.openmeterPlanId,
        created: false,
      };
    }

    if (
      isOwnerStarterPlanKey(existing.planKey) &&
      existing.planKey === plan.key &&
      existing.openmeterPlanId === plan.openmeterPlanId
    ) {
      // Keep Sandbox Starter on the free profile (org default may be Stripe).
      await applyFreeBillingProfileToCustomer({
        client,
        customerId: customer.id,
      });
      return {
        openmeterSubscriptionId: existing.id,
        planKey: existing.planKey,
        openmeterPlanId: existing.openmeterPlanId,
        created: false,
      };
    }

    if (isOwnerStarterPlanKey(existing.planKey)) {
      await applyFreeBillingProfileToCustomer({
        client,
        customerId: customer.id,
      });
      try {
        await changeKonnectSubscription({
          subscriptionId: existing.id,
          customerId: customer.id,
          planId: plan.openmeterPlanId,
          timing: "immediate",
        });
        return {
          openmeterSubscriptionId: existing.id,
          planKey: plan.key,
          openmeterPlanId: plan.openmeterPlanId,
          created: false,
        };
      } catch {
        console.warn(
          "openmeter: owner starter subscription change failed; recreating",
        );
        try {
          await client.subscriptions.cancel(existing.id, {
            timing: "immediate",
          });
        } catch {
          // fall through to create
        }
      }
    } else if (existing.id) {
      // Unknown active wallet subscription — leave it alone.
      return {
        openmeterSubscriptionId: existing.id,
        planKey: existing.planKey,
        openmeterPlanId: existing.openmeterPlanId,
        created: false,
      };
    }
  }

  // New Sandbox Starter must not inherit the org Stripe default without cus_….
  await applyFreeBillingProfileToCustomer({
    client,
    customerId: customer.id,
  });

  try {
    const createdSub = await client.subscriptions.create({
      customerId: customer.id,
      plan: { key: plan.key },
    });
    if (!createdSub?.id) {
      throw new Error("Failed to create Owner Starter subscription");
    }
    return {
      openmeterSubscriptionId: createdSub.id,
      planKey: plan.key,
      openmeterPlanId: plan.openmeterPlanId,
      created: true,
    };
  } catch (err) {
    if (isOpenMeterPlanNotFoundError(err)) {
      invalidateOwnerStarterPlanCache();
      const resynced = await ensureOwnerStarterPlanSynced(includedUsdMicros);
      const createdSub = await createOwnerStarterSubscriptionWithBillingRecovery({
        client,
        customerId: customer.id,
        planKey: resynced.key,
      });
      return {
        openmeterSubscriptionId: createdSub.id,
        planKey: resynced.key,
        openmeterPlanId: resynced.openmeterPlanId,
        created: true,
      };
    }
    if (isOpenMeterConflictError(err)) {
      const raced = await findOpenMeterSubscriptionByPlanKey(
        client,
        customer.id,
        plan.key,
        { openmeterPlanId: plan.openmeterPlanId },
      );
      if (raced?.id) {
        return {
          openmeterSubscriptionId: raced.id,
          planKey: plan.key,
          openmeterPlanId: plan.openmeterPlanId,
          created: false,
        };
      }
    }
    if (isOpenMeterStripeBillingError(err)) {
      await applyFreeBillingProfileToCustomer({
        client,
        customerId: customer.id,
      });
      const createdSub = await client.subscriptions.create({
        customerId: customer.id,
        plan: { key: plan.key },
      });
      if (!createdSub?.id) {
        throw new Error(
          "Failed to create Owner Starter subscription after billing profile apply",
        );
      }
      return {
        openmeterSubscriptionId: createdSub.id,
        planKey: plan.key,
        openmeterPlanId: plan.openmeterPlanId,
        created: true,
      };
    }
    throw err;
  }
}

async function createOwnerStarterSubscriptionWithBillingRecovery(input: {
  client: OpenMeter;
  customerId: string;
  planKey: string;
}): Promise<{ id: string }> {
  try {
    const createdSub = await input.client.subscriptions.create({
      customerId: input.customerId,
      plan: { key: input.planKey },
    });
    if (!createdSub?.id) {
      throw new Error("Failed to create Owner Starter subscription after plan sync");
    }
    return createdSub;
  } catch (err) {
    if (!isOpenMeterStripeBillingError(err)) {
      throw err;
    }
    await applyFreeBillingProfileToCustomer({
      client: input.client,
      customerId: input.customerId,
    });
    const createdSub = await input.client.subscriptions.create({
      customerId: input.customerId,
      plan: { key: input.planKey },
    });
    if (!createdSub?.id) {
      throw new Error(
        "Failed to create Owner Starter subscription after plan sync and billing profile apply",
      );
    }
    return createdSub;
  }
}
