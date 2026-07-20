import { eq } from "drizzle-orm";
import type { OpenMeter, PlanReferenceInput } from "@openmeter/sdk";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { applyFreeBillingProfileToCustomer } from "./billing-profiles";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { ensureOpenMeterCustomer } from "./customers";
import {
  isOpenMeterConflictError,
  isOpenMeterPlanNotFoundError,
} from "./plan-errors";
import {
  buildOpenMeterPlanKey,
  syncPlanToOpenMeter,
  verifyOpenMeterPlanId,
} from "./plans-sync";
import {
  findOpenMeterSubscriptionByPlanKey,
  type OpenMeterSubscriptionView,
  verifyOpenMeterSubscriptionId,
} from "./subscription-read";

async function refreshStarterPlan(planId: string): Promise<typeof plans.$inferSelect> {
  const refreshed = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!refreshed[0]) {
    throw new Error("Starter plan row missing after OpenMeter sync");
  }
  return refreshed[0];
}

export async function ensureStarterPlanSynced(clientId: string): Promise<typeof plans.$inferSelect> {
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
    if (verified?.id) {
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
    planKey,
    planId: openmeterPlanId,
    activeFrom: createdSub.activeFrom?.toISOString?.() ?? null,
    activeTo: createdSub.activeTo?.toISOString?.() ?? null,
  };
}

type StarterRecoveryInput = {
  client: OpenMeter;
  customerId: string;
  clientId: string;
  starter: typeof plans.$inferSelect;
  planKey: string;
};

type StarterRecoveryResult = {
  subscription: OpenMeterSubscriptionView | null;
  starter: typeof plans.$inferSelect;
  created: boolean;
};

function createdStarterResult(
  createdSub: NonNullable<Awaited<ReturnType<OpenMeter["subscriptions"]["create"]>>>,
  planKey: string,
  starter: typeof plans.$inferSelect,
): StarterRecoveryResult {
  return {
    subscription: subscriptionViewFromCreateResult(
      createdSub,
      planKey,
      starter.openmeterPlanId,
    ),
    starter,
    created: true,
  };
}

async function recreateAfterPlanNotFound(
  input: StarterRecoveryInput,
  starter: typeof plans.$inferSelect,
): Promise<StarterRecoveryResult> {
  const sync = await syncPlanToOpenMeter(starter.id);
  if (!sync.ok) {
    throw new Error(sync.error ?? "Failed to sync Starter plan to OpenMeter");
  }
  const activeStarter = await refreshStarterPlan(starter.id);
  const createdSub = await createStarterOpenMeterSubscription({
    client: input.client,
    customerId: input.customerId,
    starter: activeStarter,
    planKey: input.planKey,
  });
  if (!createdSub?.id) {
    throw new Error("Failed to create OpenMeter Starter subscription after plan sync");
  }
  return createdStarterResult(createdSub, input.planKey, activeStarter);
}

async function recoverFromConflict(
  input: StarterRecoveryInput,
  starter: typeof plans.$inferSelect,
  originalErr: unknown,
): Promise<StarterRecoveryResult> {
  const existing = await findOpenMeterSubscriptionByPlanKey(
    input.client,
    input.customerId,
    input.planKey,
    { openmeterPlanId: starter.openmeterPlanId },
  );
  if (existing) {
    return { subscription: existing, starter, created: false };
  }

  await applyFreeBillingProfileToCustomer({
    client: input.client,
    customerId: input.customerId,
  });
  try {
    const createdSub = await createStarterOpenMeterSubscription({
      client: input.client,
      customerId: input.customerId,
      starter,
      planKey: input.planKey,
    });
    if (createdSub?.id) {
      return createdStarterResult(createdSub, input.planKey, starter);
    }
  } catch (retryErr) {
    const existingAfterRetry = await findOpenMeterSubscriptionByPlanKey(
      input.client,
      input.customerId,
      input.planKey,
      { openmeterPlanId: starter.openmeterPlanId },
    );
    if (existingAfterRetry) {
      return {
        subscription: existingAfterRetry,
        starter,
        created: false,
      };
    }
    throw retryErr;
  }
  throw originalErr;
}

async function createStarterSubscriptionWithRecovery(
  input: StarterRecoveryInput,
): Promise<StarterRecoveryResult> {
  const activeStarter = input.starter;
  try {
    const createdSub = await createStarterOpenMeterSubscription({
      client: input.client,
      customerId: input.customerId,
      starter: activeStarter,
      planKey: input.planKey,
    });
    if (!createdSub?.id) {
      throw new Error("Failed to create OpenMeter Starter subscription");
    }
    return createdStarterResult(createdSub, input.planKey, activeStarter);
  } catch (err) {
    if (isOpenMeterPlanNotFoundError(err)) {
      return recreateAfterPlanNotFound(input, activeStarter);
    }
    if (isOpenMeterConflictError(err)) {
      return recoverFromConflict(input, activeStarter, err);
    }
    throw err;
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
  // Starter trial subscriptions always use the sandbox billing profile so Konnect
  // does not require Stripe customer data, even when the app has Stripe Connect.
  await applyFreeBillingProfileToCustomer({
    client,
    customerId: customer.id,
  });

  const planKey = buildOpenMeterPlanKey(identity.developerAppId, starter.id);

  let omSubscription = await resolveOpenMeterStarterSubscription({
    client,
    customerId: customer.id,
    planKey,
    openmeterPlanId: starter.openmeterPlanId,
    hintOpenMeterSubscriptionId: input.hintOpenMeterSubscriptionId,
  });

  let created = false;
  let activeStarter = starter;
  if (!omSubscription) {
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
