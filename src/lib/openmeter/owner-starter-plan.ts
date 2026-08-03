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
  KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
  NETWORK_FEE_USD_MICROS_METER,
} from "./constants";
import { ensureOwnerCustomer } from "./customers";
import {
  ensureKonnectTenantCatalog,
  findKonnectFeatureIdByKey,
} from "./konnect-catalog";
import { buildKonnectUsageRateCard } from "./konnect-plan-body";
import { changeKonnectSubscription } from "./konnect-subscriptions";
import {
  isOpenMeterConflictError,
  isOpenMeterPlanAlreadyPublishedError,
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

function parseIncludedMicros(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return 5_000_000;
  }
  return Math.floor(n);
}

function buildOwnerStarterPlanBody(input: {
  planKey: string;
  featureId: string;
  includedUsdMicros: number;
  unitAmount: string;
}): Record<string, unknown> {
  return {
    key: input.planKey,
    name: OWNER_STARTER_PLAN_NAME,
    currency: "USD",
    billing_cadence: "P1M",
    settlement_mode: KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
    phases: [
      {
        key: "default",
        name: "Default",
        rate_cards: [
          buildKonnectUsageRateCard({
            key: DEFAULT_TRIAL_FEATURE_KEY,
            name: "Network usage",
            featureId: input.featureId,
            unitAmount: input.unitAmount,
            includedUsdMicros: input.includedUsdMicros,
          }),
        ],
      },
    ],
    metadata: {
      pymthouse_plan_kind: "owner_starter",
      meter_slug: NETWORK_FEE_USD_MICROS_METER,
    },
  };
}

type FoundPlan = {
  id: string;
  key?: string;
  version?: number;
  status?: string;
};

async function findPlanByKey(
  client: OpenMeter,
  planKey: string,
): Promise<FoundPlan | null> {
  try {
    const listed = await client.plans.list({
      ...( { key: planKey } as Record<string, unknown> ),
      page: 1,
      pageSize: 50,
    } as Parameters<OpenMeter["plans"]["list"]>[0]);
    const items = (listed as { items?: Array<FoundPlan> })?.items ?? [];
    const exact = items.find((item) => item.key === planKey);
    if (exact?.id) {
      return exact;
    }
  } catch {
    // fall through to get-by-key
  }

  try {
    const plan = await client.plans.get(planKey);
    if (plan?.id) {
      return {
        id: plan.id,
        key: plan.key,
        version: typeof plan.version === "number" ? plan.version : undefined,
        status: plan.status,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Publish is only legal for these plan states; any other state is already live. */
function planNeedsPublish(status: string | undefined): boolean {
  return status === "draft" || status === "scheduled";
}

async function publishOwnerStarterPlanBestEffort(
  client: OpenMeter,
  planId: string,
): Promise<string> {
  try {
    const published = await client.plans.publish(planId);
    return published?.id ?? planId;
  } catch (err) {
    if (
      !isOpenMeterConflictError(err) &&
      !isOpenMeterPlanAlreadyPublishedError(err)
    ) {
      console.warn(
        "openmeter: owner starter plan publish",
        err instanceof Error ? err.message : String(err),
      );
    }
    return planId;
  }
}

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

async function createOwnerStarterPlan(input: {
  client: OpenMeter;
  planKey: string;
  featureId: string;
  includedUsdMicros: string;
}): Promise<string> {
  const body = buildOwnerStarterPlanBody({
    planKey: input.planKey,
    featureId: input.featureId,
    includedUsdMicros: parseIncludedMicros(input.includedUsdMicros),
    unitAmount: defaultRetailRateUsd(),
  });

  try {
    const created = await input.client.plans.create(
      body as unknown as Parameters<OpenMeter["plans"]["create"]>[0],
    );
    if (!created?.id) {
      throw new Error("Failed to create Owner Starter plan");
    }
    return created.id;
  } catch (err) {
    if (!isOpenMeterConflictError(err)) {
      throw err;
    }
    const raced = await findPlanByKey(input.client, input.planKey);
    if (!raced?.id) {
      throw err;
    }
    return raced.id;
  }
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

  const existing = await findPlanByKey(client, input.planKey);
  if (existing?.id) {
    if (planNeedsPublish(existing.status)) {
      await publishOwnerStarterPlanBestEffort(client, existing.id);
    }
    return {
      key: input.planKey,
      openmeterPlanId: existing.id,
      includedUsdMicros: input.includedUsdMicros,
    };
  }

  let openmeterPlanId = await createOwnerStarterPlan({
    client,
    planKey: input.planKey,
    featureId,
    includedUsdMicros: input.includedUsdMicros,
  });
  openmeterPlanId = await publishOwnerStarterPlanBestEffort(client, openmeterPlanId);

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

  const body = buildOwnerStarterPlanBody({
    planKey,
    featureId,
    includedUsdMicros: parseIncludedMicros(amount),
    unitAmount: defaultRetailRateUsd(),
  });

  const existing = await findPlanByKey(client, planKey);
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
      openmeterPlanId = await createOwnerStarterPlan({
        client,
        planKey,
        featureId,
        includedUsdMicros: amount,
      });
    }
  } else {
    openmeterPlanId = await createOwnerStarterPlan({
      client,
      planKey,
      featureId,
      includedUsdMicros: amount,
    });
  }

  openmeterPlanId = await publishOwnerStarterPlanBestEffort(client, openmeterPlanId);
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
    if (
      isOwnerStarterPlanKey(existing.planKey) &&
      existing.planKey === plan.key &&
      existing.openmeterPlanId === plan.openmeterPlanId
    ) {
      return {
        openmeterSubscriptionId: existing.id,
        planKey: existing.planKey,
        openmeterPlanId: existing.openmeterPlanId,
        created: false,
      };
    }

    if (isOwnerStarterPlanKey(existing.planKey)) {
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
      } catch (err) {
        console.warn(
          "openmeter: owner starter subscription change failed; recreating",
          err instanceof Error ? err.message : String(err),
        );
        try {
          await client.subscriptions.cancel(existing.id, {
            timing: "immediate",
          });
        } catch {
          // fall through to create
        }
      }
    }
  }

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
