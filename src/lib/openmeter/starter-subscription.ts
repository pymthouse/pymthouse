import { eq } from "drizzle-orm";
import type { OpenMeter, PlanReferenceInput } from "@openmeter/sdk";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import {
  applyFreeBillingProfileToCustomer,
  getAppBillingConfig,
  prepareAppCustomerStripeBilling,
} from "./billing-profiles";
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
 * Recover from Konnect's Stripe-setup 409 when creating Starter.
 * Merchant apps pin Custom Invoicing (credits-first still settles via
 * settlement). Owner-rollup / unset apps use the sandbox free profile.
 * @internal Exported for unit tests.
 */
export async function recoverStarterBillingProfile(
  input: {
    client: OpenMeter;
    customerId: string;
    clientId?: string;
  },
  deps?: {
    getConfig?: typeof getAppBillingConfig;
    prepareMerchant?: typeof prepareAppCustomerStripeBilling;
    applyFree?: typeof applyFreeBillingProfileToCustomer;
  },
): Promise<"merchant" | "free"> {
  const getConfig = deps?.getConfig ?? getAppBillingConfig;
  const prepareMerchant =
    deps?.prepareMerchant ?? prepareAppCustomerStripeBilling;
  const applyFree = deps?.applyFree ?? applyFreeBillingProfileToCustomer;

  if (input.clientId) {
    const config = await getConfig(input.clientId);
    if (config?.billingMode === "merchant") {
      await prepareMerchant({
        client: input.client,
        clientId: input.clientId,
        customerId: input.customerId,
      });
      return "merchant";
    }
  }
  await applyFree({
    client: input.client,
    customerId: input.customerId,
  });
  return "free";
}

/**
 * Eager Custom Invoicing pin for merchant Starter users (before create).
 * @internal Exported for unit tests.
 */
export async function pinMerchantCustomInvoicingIfNeeded(
  input: {
    client: OpenMeter;
    clientId: string;
    customerId: string;
    customerKey?: string;
  },
  deps?: {
    getConfig?: typeof getAppBillingConfig;
    prepareMerchant?: typeof prepareAppCustomerStripeBilling;
  },
): Promise<boolean> {
  const getConfig = deps?.getConfig ?? getAppBillingConfig;
  const prepareMerchant =
    deps?.prepareMerchant ?? prepareAppCustomerStripeBilling;
  const billingConfig = await getConfig(input.clientId);
  if (billingConfig?.billingMode !== "merchant") {
    return false;
  }
  await prepareMerchant({
    client: input.client,
    clientId: input.clientId,
    customerId: input.customerId,
    customerKey: input.customerKey,
  });
  return true;
}

/**
 * Create a Starter subscription. On the Konnect Stripe-setup 409
 * ({@link isOpenMeterStripeBillingError}), recover the billing profile once
 * and retry. Merchant apps pin Custom Invoicing; others use the sandbox free
 * profile. On a plain conflict with an existing sub, return that sub.
 * @internal Exported for unit tests.
 */
export async function createStarterSubscriptionWithBillingRecovery(
  input: {
    client: OpenMeter;
    customerId: string;
    starter: typeof plans.$inferSelect;
    planKey: string;
    /** When set, merchant-mode apps recover onto Custom Invoicing instead of Sandbox. */
    clientId?: string;
  },
  deps?: {
    recoverProfile?: typeof recoverStarterBillingProfile;
  },
): Promise<{
  subscription: OpenMeterSubscriptionView;
  created: boolean;
}> {
  const recoverProfile =
    deps?.recoverProfile ?? recoverStarterBillingProfile;
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

    await recoverProfile({
      client: input.client,
      customerId: input.customerId,
      clientId: input.clientId,
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
      clientId: input.clientId,
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
      clientId: input.clientId,
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

  const { ownerCostRailUserId, resolveOpenMeterBillingIdentity } = await import(
    "@/lib/openmeter/billing-identity"
  );
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

  // Owners and owner_rollup end-users share one platform Owner Starter.
  // Return the requesting app's local Starter id for callers that cache planId.
  const ownerUserId = ownerCostRailUserId(identity);
  if (ownerUserId) {
    const { ensureOwnerStarterSubscription } = await import(
      "@/lib/openmeter/owner-starter-plan"
    );
    const { listOwnedPublicClientIds } = await import("./customers");
    const ownedClientIds = await listOwnedPublicClientIds(ownerUserId);
    const ensured = await ensureOwnerStarterSubscription({
      ownerUserId,
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
  const customer = await ensureOpenMeterCustomer(
    client,
    identity.payerCustomerKey,
  );
  // Merchant apps: pin Custom Invoicing (+ settlement metadata) at Starter
  // create so credits-first usage still invoices through settlement once a
  // card is on file. Do not use Sandbox — it fake-pays and skips Connect.
  // Owner-rollup Starters stay unpinned until paid checkout (Konnect rejects
  // Stripe-profile customers without a default payment method).
  await pinMerchantCustomInvoicingIfNeeded({
    client,
    clientId: identity.developerAppId,
    customerId: customer.id,
    customerKey: identity.payerCustomerKey,
  });

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
    // Profile recovery on Stripe-setup 409 lives in
    // createStarterSubscriptionWithBillingRecovery (Custom Invoicing for
    // merchant apps; sandbox free profile otherwise).
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
