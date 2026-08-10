import { eq } from "drizzle-orm";
import type { OpenMeter, PlanReferenceInput } from "@openmeter/sdk";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { applyFreeBillingProfileToCustomer } from "./billing-profiles";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { ensureOpenMeterCustomer } from "./customers";
import {
  isOpenMeterConflictError,
  isOpenMeterPlanNotFoundError,
  isOpenMeterStripeBillingError,
} from "./plan-errors";
import {
  buildOpenMeterPlanKey,
  syncPlanToOpenMeter,
  verifyOpenMeterPlanId,
} from "./plans-sync";
import {
  findOpenMeterSubscriptionByPlanKey,
  listOpenMeterSubscriptionsForCustomer,
  type OpenMeterSubscriptionView,
  verifyOpenMeterSubscriptionId,
} from "./subscription-read";
import { pickSlotOccupyingSubscription } from "./subscription-state";

async function refreshStarterPlan(planId: string): Promise<typeof plans.$inferSelect> {
  const refreshed = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!refreshed[0]) {
    throw new Error("Starter plan row missing after OpenMeter sync");
  }
  return refreshed[0];
}

/**
 * A verified Starter plan sync is stable (plan rows and their OpenMeter ids
 * change only on publish flows), so remember it per app instead of re-reading
 * Neon and re-verifying the OpenMeter plan on every mint/provision call.
 */
let starterPlanSyncedCache: ReturnType<
  typeof createAsyncTtlCache<typeof plans.$inferSelect>
> | null = null;

function getStarterPlanSyncedCache() {
  starterPlanSyncedCache ??= createAsyncTtlCache<typeof plans.$inferSelect>({
    ttlSeconds: resolveCacheTtlSeconds("STARTER_PLAN_SYNC_CACHE_TTL_SECONDS", 300),
  });
  return starterPlanSyncedCache;
}

export function resetStarterPlanSyncedCacheForTests(): void {
  starterPlanSyncedCache = null;
}

export async function ensureStarterPlanSynced(clientId: string): Promise<typeof plans.$inferSelect> {
  return getStarterPlanSyncedCache().get(clientId, () =>
    ensureStarterPlanSyncedUncached(clientId),
  );
}

async function ensureStarterPlanSyncedUncached(
  clientId: string,
): Promise<typeof plans.$inferSelect> {
  const starter = await getOrCreateStarterPlan(clientId);
  if (!isHostedAdminClientAvailable()) {
    return starter;
  }

  const client = getHostedAdminClient();
  const verified = starter.openmeterPlanId
    ? await verifyOpenMeterPlanId(client, starter.openmeterPlanId)
    : null;

  if (!verified) {
    const sync = await syncPlanToOpenMeter(starter.id);
    if (!sync.ok) {
      throw new Error(sync.error ?? "Failed to sync Starter plan to OpenMeter");
    }
    return refreshStarterPlan(starter.id);
  }

  return starter;
}

function buildStarterSubscriptionPlanRef(
  starter: typeof plans.$inferSelect,
  planKey: string,
): PlanReferenceInput | { id: string } {
  if (starter.openmeterPlanId) {
    return { id: starter.openmeterPlanId };
  }
  return { key: planKey };
}

async function createStarterOpenMeterSubscription(input: {
  client: OpenMeter;
  customerId: string;
  starter: typeof plans.$inferSelect;
  planKey: string;
}) {
  return input.client.subscriptions.create({
    customerId: input.customerId,
    // OpenMeter accepts a plan reference by { id } or { key }, but the SDK input
    // type only models { key }; narrow to the SDK shape for the create call.
    plan: buildStarterSubscriptionPlanRef(input.starter, input.planKey) as PlanReferenceInput,
  });
}

/**
 * The subscription already holding this customer's slot, on any plan.
 *
 * A user who moved off Starter (Pay as you go, Owner Paid, …) has no Starter row
 * to find, but their current plan still blocks `subscriptions.create`. Without
 * this, every mint retried a Starter create that could only 409, which failed
 * closed as `billing_unavailable` and rejected every signed-payment request.
 * @internal Exported for unit tests.
 */
export async function findSlotOccupyingSubscription(
  client: OpenMeter,
  customerId: string,
): Promise<OpenMeterSubscriptionView | null> {
  const listed = await listOpenMeterSubscriptionsForCustomer(client, customerId);
  return pickSlotOccupyingSubscription(listed) ?? null;
}

async function resolveOpenMeterStarterSubscription(input: {
  client: OpenMeter;
  customerId: string;
  planKey: string;
  openmeterPlanId: string | null;
  hintOpenMeterSubscriptionId?: string | null;
}) {
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
      return verified;
    }
  }

  return findOpenMeterSubscriptionByPlanKey(input.client, input.customerId, input.planKey, {
    openmeterPlanId: input.openmeterPlanId,
  });
}

function subscriptionViewFromCreateResult(
  createdSub: NonNullable<Awaited<ReturnType<OpenMeter["subscriptions"]["create"]>>>,
  planKey: string,
  openmeterPlanId: string | null,
): OpenMeterSubscriptionView {
  return {
    id: createdSub.id,
    status: createdSub.status,
    customerId: createdSub.customerId ?? null,
    planKey,
    planId: openmeterPlanId,
    activeFrom: createdSub.activeFrom?.toISOString?.() ?? null,
    activeTo: createdSub.activeTo?.toISOString?.() ?? null,
  };
}

/**
 * Create a Starter subscription. On the Konnect Stripe-setup 409
 * ({@link isOpenMeterStripeBillingError}), apply the sandbox free billing
 * profile once and retry. On a plain conflict with an existing sub, return
 * that sub. Does not eagerly apply the profile — it only exists to recover
 * from that specific error.
 * @internal Exported for unit tests.
 */
export async function createStarterSubscriptionWithBillingRecovery(input: {
  client: OpenMeter;
  customerId: string;
  starter: typeof plans.$inferSelect;
  planKey: string;
}): Promise<{
  subscription: OpenMeterSubscriptionView;
  created: boolean;
}> {
  try {
    const createdSub = await createStarterOpenMeterSubscription(input);
    if (!createdSub?.id) {
      throw new Error("Failed to create OpenMeter Starter subscription");
    }
    return {
      subscription: subscriptionViewFromCreateResult(
        createdSub,
        input.planKey,
        input.starter.openmeterPlanId,
      ),
      created: true,
    };
  } catch (err) {
    if (isOpenMeterConflictError(err)) {
      const existing = await findOpenMeterSubscriptionByPlanKey(
        input.client,
        input.customerId,
        input.planKey,
        { openmeterPlanId: input.starter.openmeterPlanId },
      );
      if (existing) {
        return { subscription: existing, created: false };
      }
      // Raced past the pre-create check, or the slot is held by another plan.
      const occupying = await findSlotOccupyingSubscription(
        input.client,
        input.customerId,
      );
      if (occupying) {
        return { subscription: occupying, created: false };
      }
    }

    if (!isOpenMeterStripeBillingError(err)) {
      if (isOpenMeterConflictError(err)) {
        throw new Error(
          `OpenMeter rejected the Starter subscription for customer ${input.customerId} ` +
            `(plan ${input.planKey}) as a conflict, but no subscription holds the slot: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      throw err;
    }

    await applyFreeBillingProfileToCustomer({
      client: input.client,
      customerId: input.customerId,
    });
    try {
      const createdSub = await createStarterOpenMeterSubscription(input);
      if (!createdSub?.id) {
        throw new Error(
          "Failed to create OpenMeter Starter subscription after billing profile apply",
        );
      }
      return {
        subscription: subscriptionViewFromCreateResult(
          createdSub,
          input.planKey,
          input.starter.openmeterPlanId,
        ),
        created: true,
      };
    } catch (retryErr) {
      if (isOpenMeterConflictError(retryErr)) {
        const existingAfterRetry = await findOpenMeterSubscriptionByPlanKey(
          input.client,
          input.customerId,
          input.planKey,
          { openmeterPlanId: input.starter.openmeterPlanId },
        );
        if (existingAfterRetry) {
          return { subscription: existingAfterRetry, created: false };
        }
      }
      throw retryErr;
    }
  }
}

async function createStarterSubscriptionWithRecovery(input: {
  client: OpenMeter;
  customerId: string;
  clientId: string;
  starter: typeof plans.$inferSelect;
  planKey: string;
}): Promise<{
  subscription: OpenMeterSubscriptionView | null;
  starter: typeof plans.$inferSelect;
  created: boolean;
}> {
  let activeStarter = input.starter;
  try {
    const provisioned = await createStarterSubscriptionWithBillingRecovery({
      client: input.client,
      customerId: input.customerId,
      starter: activeStarter,
      planKey: input.planKey,
    });
    return {
      subscription: provisioned.subscription,
      starter: activeStarter,
      created: provisioned.created,
    };
  } catch (err) {
    if (!isOpenMeterPlanNotFoundError(err)) {
      throw err;
    }

    const sync = await syncPlanToOpenMeter(activeStarter.id);
    if (!sync.ok) {
      throw new Error(sync.error ?? "Failed to sync Starter plan to OpenMeter");
    }
    activeStarter = await refreshStarterPlan(activeStarter.id);
    // Replace any cached pre-resync plan row so later ensures see the new
    // OpenMeter plan id immediately.
    getStarterPlanSyncedCache().seed(input.clientId, activeStarter);

    const provisioned = await createStarterSubscriptionWithBillingRecovery({
      client: input.client,
      customerId: input.customerId,
      starter: activeStarter,
      planKey: input.planKey,
    });
    return {
      subscription: provisioned.subscription,
      starter: activeStarter,
      created: provisioned.created,
    };
  }
}

export async function ensureStarterSubscriptionForAppUser(input: {
  clientId: string;
  externalUserId: string;
  hintOpenMeterSubscriptionId?: string | null;
}): Promise<{
  openmeterSubscriptionId: string | null;
  planId: string;
  created: boolean;
}> {
  if (!isHostedAdminClientAvailable()) {
    const { resolveOpenMeterBillingIdentity } = await import(
      "@/lib/openmeter/billing-identity"
    );
    const identity = await resolveOpenMeterBillingIdentity({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });
    const starter = await getOrCreateStarterPlan(identity.developerAppId);
    return {
      openmeterSubscriptionId: null,
      planId: starter.id,
      created: false,
    };
  }

  const { resolveOpenMeterBillingIdentity } = await import(
    "@/lib/openmeter/billing-identity"
  );
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

  // Owners share one platform Owner Starter plan (not a per-app Neon plans row).
  // Return the requesting app's local Starter id for callers that cache planId.
  if (identity.isOwner && identity.ownerUserId) {
    const { ensureOwnerStarterSubscription } = await import(
      "@/lib/openmeter/owner-starter-plan"
    );
    const { listOwnedPublicClientIds } = await import("./customers");
    const ownedClientIds = await listOwnedPublicClientIds(identity.ownerUserId);
    const ensured = await ensureOwnerStarterSubscription({
      ownerUserId: identity.ownerUserId,
      publicClientIds: [
        ...new Set([identity.publicClientId, ...ownedClientIds]),
      ],
      hintOpenMeterSubscriptionId: input.hintOpenMeterSubscriptionId,
    });
    const starter = await getOrCreateStarterPlan(identity.developerAppId);
    return {
      openmeterSubscriptionId: ensured.openmeterSubscriptionId,
      planId: starter.id,
      created: ensured.created,
    };
  }

  const starter = await ensureStarterPlanSynced(identity.developerAppId);
  if (!starter.openmeterPlanId) {
    throw new Error("Starter plan is not synced to OpenMeter");
  }

  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomer(client, identity.customerKey);
  // Starter needs no Stripe setup: end users only get a Stripe customer and a
  // payment method when they check out into a paid plan. Pinning them to the
  // app's Stripe billing profile here makes Konnect reject the subscription
  // with "customers need a default payment method".

  const planKey = buildOpenMeterPlanKey(identity.developerAppId, starter.id);

  let omSubscription = await resolveOpenMeterStarterSubscription({
    client,
    customerId: customer.id,
    planKey,
    openmeterPlanId: starter.openmeterPlanId,
    hintOpenMeterSubscriptionId: input.hintOpenMeterSubscriptionId,
  });

  // Users who upgraded off Starter keep a slot-holding row on another plan.
  // They are provisioned; creating Starter for them can only 409.
  omSubscription ??= await findSlotOccupyingSubscription(client, customer.id);

  let created = false;
  let activeStarter = starter;
  if (!omSubscription) {
    // Free billing-profile override is applied only inside
    // createStarterSubscriptionWithBillingRecovery when Konnect returns the
    // Stripe-setup 409 (isOpenMeterStripeBillingError) — not eagerly.
    const provisioned = await createStarterSubscriptionWithRecovery({
      client,
      customerId: customer.id,
      clientId: identity.developerAppId,
      starter: activeStarter,
      planKey,
    });
    omSubscription = provisioned.subscription;
    activeStarter = provisioned.starter;
    created = provisioned.created;
  }

  if (!omSubscription) {
    throw new Error(
      `Failed to provision OpenMeter Starter subscription for client ${identity.developerAppId}`,
    );
  }

  return {
    openmeterSubscriptionId: omSubscription.id,
    planId: activeStarter.id,
    created,
  };
}
