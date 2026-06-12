import { eq } from "drizzle-orm";
import type { OpenMeter } from "@openmeter/sdk";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { applyTenantBillingProfileToCustomer } from "./billing-profiles";
import { ensureOpenMeterCustomerForAppUser } from "./customers";
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
): { id: string } | { key: string } {
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
    plan: buildStarterSubscriptionPlanRef(input.starter, input.planKey) as {
      key: string;
      version?: number;
    },
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
    const starter = await getOrCreateStarterPlan(input.clientId);
    return {
      openmeterSubscriptionId: null,
      planId: starter.id,
      created: false,
    };
  }

  const starter = await ensureStarterPlanSynced(input.clientId);
  if (!starter.openmeterPlanId) {
    throw new Error("Starter plan is not synced to OpenMeter");
  }

  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  await applyTenantBillingProfileToCustomer({
    client,
    clientId: input.clientId,
    customerId: customer.id,
  });

  const planKey = buildOpenMeterPlanKey(input.clientId, starter.id);

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
    try {
      const createdSub = await createStarterOpenMeterSubscription({
        client,
        customerId: customer.id,
        starter: activeStarter,
        planKey,
      });
      if (!createdSub?.id) {
        throw new Error("Failed to create OpenMeter Starter subscription");
      }
      omSubscription = {
        id: createdSub.id,
        status: createdSub.status,
        planKey,
        activeFrom: createdSub.activeFrom?.toISOString?.() ?? null,
        activeTo: createdSub.activeTo?.toISOString?.() ?? null,
      };
      created = true;
    } catch (err) {
      if (isOpenMeterPlanNotFoundError(err)) {
        const sync = await syncPlanToOpenMeter(activeStarter.id);
        if (!sync.ok) {
          throw new Error(sync.error ?? "Failed to sync Starter plan to OpenMeter");
        }
        activeStarter = await refreshStarterPlan(activeStarter.id);
        const createdSub = await createStarterOpenMeterSubscription({
          client,
          customerId: customer.id,
          starter: activeStarter,
          planKey,
        });
        if (!createdSub?.id) {
          throw new Error("Failed to create OpenMeter Starter subscription after plan sync");
        }
        omSubscription = {
          id: createdSub.id,
          status: createdSub.status,
          planKey,
          activeFrom: createdSub.activeFrom?.toISOString?.() ?? null,
          activeTo: createdSub.activeTo?.toISOString?.() ?? null,
        };
        created = true;
      } else if (isOpenMeterConflictError(err)) {
        omSubscription = await findOpenMeterSubscriptionByPlanKey(client, customer.id, planKey, {
          openmeterPlanId: activeStarter.openmeterPlanId,
        });
      } else {
        throw err;
      }
    }
  }

  if (!omSubscription) {
    throw new Error("Failed to provision OpenMeter Starter subscription");
  }

  return {
    openmeterSubscriptionId: omSubscription.id,
    planId: activeStarter.id,
    created,
  };
}
