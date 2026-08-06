import type { OpenMeter } from "@openmeter/sdk";

import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import { resolveOwnerStarterIncludedUsdMicros } from "@/lib/billing/owner-billing-config";
import {
  resolvePlatformOwnerStarterDefault,
  resolvePlatformOwnerStarterIncludedUsdMicros,
  resolvePlatformOwnerStarterPlanName,
} from "@/lib/billing/platform-owner-starter-default";
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
  createOwnerAllowancePlan,
  findOpenMeterPlanByKey,
  forceSyncOwnerAllowancePlan,
  openMeterPlanNeedsPublish,
  publishOpenMeterPlanBestEffort,
} from "./owner-allowance-plan";
import {
  isOpenMeterConflictError,
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
    planName: await resolvePlatformOwnerStarterPlanName(),
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
  const platformDefault = await resolvePlatformOwnerStarterDefault();
  const amount = includedUsdMicros.trim();
  const planKey = ownerStarterPlanKeyForAmount(
    amount,
    platformDefault.ownerStarterIncludedUsdMicros,
  );

  const synced = await forceSyncOwnerAllowancePlan({
    planKey,
    planName: platformDefault.ownerStarterPlanName,
    planKind: "owner_starter",
    includedUsdMicros: amount,
    warnLabel: "owner starter",
  });

  invalidateOwnerStarterPlanCache();
  const ref: OwnerStarterPlanRef = {
    key: synced.key,
    openmeterPlanId: synced.openmeterPlanId,
    includedUsdMicros: synced.includedUsdMicros,
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
    if (
      verified?.id &&
      verified.customerId &&
      verified.customerId === input.customerId
    ) {
      return {
        id: verified.id,
        // Never invent the target Starter key — Konnect often omits plan.key;
        // falling back to input.planKey mislabels Producer/Paid wallets as Starter
        // and triggers a destructive subscription-change onto Starter.
        planKey: verified.planKey ?? "",
        openmeterPlanId: verified.planId ?? "",
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
      planKey: existing.planKey ?? "",
      openmeterPlanId: existing.planId ?? "",
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
        s.status === "canceled" ||
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

/**
 * Subscribe the shared owner customer to the Owner Starter plan for their
 * resolved allowance (platform default or per-owner override).
 */
type OwnerWalletSubscriptionRef = {
  id: string;
  planKey: string;
  openmeterPlanId: string;
};

type OwnerStarterSubscriptionResult = {
  openmeterSubscriptionId: string | null;
  planKey: string;
  openmeterPlanId: string;
  created: boolean;
};

async function recreateOwnerStarterAfterChangeFailure(input: {
  client: OpenMeter;
  customerId: string;
  plan: OwnerStarterPlanRef;
  existingId: string;
  changeErr: unknown;
}): Promise<OwnerStarterSubscriptionResult> {
  try {
    const createdSub = await createOwnerStarterSubscriptionWithBillingRecovery({
      client: input.client,
      customerId: input.customerId,
      planKey: input.plan.key,
    });
    try {
      await input.client.subscriptions.cancel(input.existingId, {
        timing: "immediate",
      });
    } catch (cancelErr) {
      console.warn(
        "openmeter: owner starter old subscription cancel after recreate failed",
        cancelErr,
      );
    }
    return {
      openmeterSubscriptionId: createdSub.id,
      planKey: input.plan.key,
      openmeterPlanId: input.plan.openmeterPlanId,
      created: true,
    };
  } catch {
    // Keep the existing subscription; surface the original change failure.
    throw input.changeErr;
  }
}

async function changeOrRecreateOwnerStarter(input: {
  client: OpenMeter;
  customerId: string;
  plan: OwnerStarterPlanRef;
  existing: OwnerWalletSubscriptionRef;
}): Promise<OwnerStarterSubscriptionResult> {
  await applyFreeBillingProfileToCustomer({
    client: input.client,
    customerId: input.customerId,
  });
  try {
    await changeKonnectSubscription({
      subscriptionId: input.existing.id,
      customerId: input.customerId,
      planId: input.plan.openmeterPlanId,
      timing: "immediate",
    });
    return {
      openmeterSubscriptionId: input.existing.id,
      planKey: input.plan.key,
      openmeterPlanId: input.plan.openmeterPlanId,
      created: false,
    };
  } catch (changeErr) {
    console.warn(
      "openmeter: owner starter subscription change failed; recreating without cancel-first",
      changeErr,
    );
    // Create the replacement first; cancel the old subscription only after
    // the new one exists so a create failure cannot leave the owner with none.
    return recreateOwnerStarterAfterChangeFailure({
      client: input.client,
      customerId: input.customerId,
      plan: input.plan,
      existingId: input.existing.id,
      changeErr,
    });
  }
}

async function reconcileExistingOwnerWalletSubscription(input: {
  client: OpenMeter;
  customerId: string;
  plan: OwnerStarterPlanRef;
  existing: OwnerWalletSubscriptionRef;
}): Promise<OwnerStarterSubscriptionResult | null> {
  // Already on Owner Paid — do not recreate Sandbox Starter or re-pin sandbox.
  if (isOwnerPaidPlanKey(input.existing.planKey)) {
    return {
      openmeterSubscriptionId: input.existing.id,
      planKey: input.existing.planKey,
      openmeterPlanId: input.existing.openmeterPlanId,
      created: false,
    };
  }

  if (
    isOwnerStarterPlanKey(input.existing.planKey) &&
    input.existing.planKey === input.plan.key &&
    input.existing.openmeterPlanId === input.plan.openmeterPlanId
  ) {
    // Keep Sandbox Starter on the free profile (org default may be Stripe).
    await applyFreeBillingProfileToCustomer({
      client: input.client,
      customerId: input.customerId,
    });
    return {
      openmeterSubscriptionId: input.existing.id,
      planKey: input.existing.planKey,
      openmeterPlanId: input.existing.openmeterPlanId,
      created: false,
    };
  }

  if (isOwnerStarterPlanKey(input.existing.planKey)) {
    return changeOrRecreateOwnerStarter({
      client: input.client,
      customerId: input.customerId,
      plan: input.plan,
      existing: input.existing,
    });
  }

  if (input.existing.id) {
    // Unknown active wallet subscription — leave it alone.
    return {
      openmeterSubscriptionId: input.existing.id,
      planKey: input.existing.planKey,
      openmeterPlanId: input.existing.openmeterPlanId,
      created: false,
    };
  }

  return null;
}

async function createOwnerStarterSubscriptionFresh(input: {
  client: OpenMeter;
  customerId: string;
  plan: OwnerStarterPlanRef;
  includedUsdMicros: string;
}): Promise<OwnerStarterSubscriptionResult> {
  // New Sandbox Starter must not inherit the org Stripe default without cus_….
  await applyFreeBillingProfileToCustomer({
    client: input.client,
    customerId: input.customerId,
  });

  try {
    const createdSub = await input.client.subscriptions.create({
      customerId: input.customerId,
      plan: { key: input.plan.key },
    });
    if (!createdSub?.id) {
      throw new Error("Failed to create Owner Starter subscription");
    }
    return {
      openmeterSubscriptionId: createdSub.id,
      planKey: input.plan.key,
      openmeterPlanId: input.plan.openmeterPlanId,
      created: true,
    };
  } catch (err) {
    if (isOpenMeterPlanNotFoundError(err)) {
      invalidateOwnerStarterPlanCache();
      const resynced = await ensureOwnerStarterPlanSynced(input.includedUsdMicros);
      const createdSub = await createOwnerStarterSubscriptionWithBillingRecovery({
        client: input.client,
        customerId: input.customerId,
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
        input.client,
        input.customerId,
        input.plan.key,
        { openmeterPlanId: input.plan.openmeterPlanId },
      );
      if (raced?.id) {
        return {
          openmeterSubscriptionId: raced.id,
          planKey: input.plan.key,
          openmeterPlanId: input.plan.openmeterPlanId,
          created: false,
        };
      }
    }
    if (isOpenMeterStripeBillingError(err)) {
      await applyFreeBillingProfileToCustomer({
        client: input.client,
        customerId: input.customerId,
      });
      const createdSub = await input.client.subscriptions.create({
        customerId: input.customerId,
        plan: { key: input.plan.key },
      });
      if (!createdSub?.id) {
        throw new Error(
          "Failed to create Owner Starter subscription after billing profile apply",
        );
      }
      return {
        openmeterSubscriptionId: createdSub.id,
        planKey: input.plan.key,
        openmeterPlanId: input.plan.openmeterPlanId,
        created: true,
      };
    }
    throw err;
  }
}

export async function ensureOwnerStarterSubscription(input: {
  ownerUserId: string;
  publicClientIds?: string[];
  hintOpenMeterSubscriptionId?: string | null;
  /** When false, skip creating a subscription if the owner has none. */
  createIfMissing?: boolean;
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
    const reconciled = await reconcileExistingOwnerWalletSubscription({
      client,
      customerId: customer.id,
      plan,
      existing,
    });
    if (reconciled) {
      return reconciled;
    }
  }

  if (input.createIfMissing === false) {
    return {
      openmeterSubscriptionId: null,
      planKey: plan.key,
      openmeterPlanId: plan.openmeterPlanId,
      created: false,
    };
  }

  return createOwnerStarterSubscriptionFresh({
    client,
    customerId: customer.id,
    plan,
    includedUsdMicros,
  });
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
