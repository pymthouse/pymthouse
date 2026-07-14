import { eq } from "drizzle-orm";
import type { OpenMeter, PlanReferenceInput } from "@openmeter/sdk";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { applyFreeBillingProfileToCustomer } from "./billing-profiles";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { ensureOpenMeterCustomer, ensureOpenMeterCustomerForAppUser } from "./customers";
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
  listOpenMeterSubscriptionsForCustomer,
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
    const createdSub = await createStarterOpenMeterSubscription({
      client: input.client,
      customerId: input.customerId,
      starter: activeStarter,
      planKey: input.planKey,
    });
    if (!createdSub?.id) {
      throw new Error("Failed to create OpenMeter Starter subscription");
    }
    return {
      subscription: subscriptionViewFromCreateResult(
        createdSub,
        input.planKey,
        activeStarter.openmeterPlanId,
      ),
      starter: activeStarter,
      created: true,
    };
  } catch (err) {
    if (isOpenMeterPlanNotFoundError(err)) {
      const sync = await syncPlanToOpenMeter(activeStarter.id);
      if (!sync.ok) {
        throw new Error(sync.error ?? "Failed to sync Starter plan to OpenMeter");
      }
      activeStarter = await refreshStarterPlan(activeStarter.id);
      const createdSub = await createStarterOpenMeterSubscription({
        client: input.client,
        customerId: input.customerId,
        starter: activeStarter,
        planKey: input.planKey,
      });
      if (!createdSub?.id) {
        throw new Error("Failed to create OpenMeter Starter subscription after plan sync");
      }
      return {
        subscription: subscriptionViewFromCreateResult(
          createdSub,
          input.planKey,
          activeStarter.openmeterPlanId,
        ),
        starter: activeStarter,
        created: true,
      };
    }
    if (isOpenMeterConflictError(err)) {
      const existing = await findOpenMeterSubscriptionByPlanKey(
        input.client,
        input.customerId,
        input.planKey,
        { openmeterPlanId: activeStarter.openmeterPlanId },
      );
      if (existing) {
        return { subscription: existing, starter: activeStarter, created: false };
      }

      await applyFreeBillingProfileToCustomer({
        client: input.client,
        customerId: input.customerId,
      });
      try {
        const createdSub = await createStarterOpenMeterSubscription({
          client: input.client,
          customerId: input.customerId,
          starter: activeStarter,
          planKey: input.planKey,
        });
        if (createdSub?.id) {
          return {
            subscription: subscriptionViewFromCreateResult(
              createdSub,
              input.planKey,
              activeStarter.openmeterPlanId,
            ),
            starter: activeStarter,
            created: true,
          };
        }
      } catch (retryErr) {
        const existingAfterRetry = await findOpenMeterSubscriptionByPlanKey(
          input.client,
          input.customerId,
          input.planKey,
          { openmeterPlanId: activeStarter.openmeterPlanId },
        );
        if (existingAfterRetry) {
          return {
            subscription: existingAfterRetry,
            starter: activeStarter,
            created: false,
          };
        }
        throw retryErr;
      }
      throw err;
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

  const starter = await ensureStarterPlanSynced(identity.developerAppId);
  if (!starter.openmeterPlanId) {
    throw new Error("Starter plan is not synced to OpenMeter");
  }

  const client = getHostedAdminClient();
  const customer = identity.isOwner
    ? await ensureOpenMeterCustomerForAppUser({
        client,
        clientId: input.clientId,
        externalUserId: input.externalUserId,
      })
    : await ensureOpenMeterCustomer(client, identity.customerKey);
  // Starter trial subscriptions always use the sandbox billing profile so Konnect
  // does not require Stripe customer data, even when the app has Stripe Connect.
  await applyFreeBillingProfileToCustomer({
    client,
    customerId: customer.id,
  });

  // Owners already subscribed (any plan) skip creating another Starter on a second app.
  if (identity.isOwner) {
    const existingAny = await findOpenMeterSubscriptionByPlanKey(
      client,
      customer.id,
      buildOpenMeterPlanKey(identity.developerAppId, starter.id),
      { openmeterPlanId: starter.openmeterPlanId },
    );
    if (existingAny?.id) {
      return {
        openmeterSubscriptionId: existingAny.id,
        planId: starter.id,
        created: false,
      };
    }
    // Also accept any active subscription on the owner customer (from another app).
    try {
      const listed = await listOpenMeterSubscriptionsForCustomer(
        client,
        customer.id,
      );
      const active = listed.find(
        (s) =>
          s.status === "active" ||
          s.status === "trialing" ||
          !s.status,
      );
      if (active?.id) {
        return {
          openmeterSubscriptionId: active.id,
          planId: starter.id,
          created: false,
        };
      }
    } catch {
      // fall through to create
    }
  }

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
