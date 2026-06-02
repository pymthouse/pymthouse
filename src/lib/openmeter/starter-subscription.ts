import { and, eq, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { OpenMeter } from "@openmeter/sdk";
import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { applyTenantBillingProfileToCustomer } from "./billing-profiles";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { ensureOpenMeterCustomerForAppUser } from "./customers";
import { isOpenMeterConflictError } from "./plan-errors";
import { buildOpenMeterPlanKey } from "./plans-sync";
import { syncPlanToOpenMeter } from "./plans-sync";

const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "pending"] as const;

const OPENMETER_SUBSCRIPTION_ACTIVE_STATUSES = new Set(["active", "scheduled"]);

export async function ensureStarterPlanSynced(clientId: string): Promise<typeof plans.$inferSelect> {
  const starter = await getOrCreateStarterPlan(clientId);
  if (!starter.openmeterPlanId && isHostedAdminClientAvailable()) {
    const sync = await syncPlanToOpenMeter(starter.id);
    if (!sync.ok) {
      throw new Error(sync.error ?? "Failed to sync Starter plan to OpenMeter");
    }
    const refreshed = await db
      .select()
      .from(plans)
      .where(eq(plans.id, starter.id))
      .limit(1);
    return refreshed[0] ?? starter;
  }
  return starter;
}

async function findOpenMeterStarterSubscription(
  client: OpenMeter,
  customerId: string,
  planKey: string,
): Promise<{ id: string } | null> {
  const listed = await client.customers.listSubscriptions(customerId, { pageSize: 100 });
  for (const item of listed?.items ?? []) {
    if (item.plan?.key !== planKey) {
      continue;
    }
    if (!OPENMETER_SUBSCRIPTION_ACTIVE_STATUSES.has(item.status)) {
      continue;
    }
    return { id: item.id };
  }
  return null;
}

async function persistStarterSubscriptionRow(input: {
  clientId: string;
  externalUserId: string;
  planId: string;
  openmeterSubscriptionId: string | null;
}): Promise<string> {
  const customerKey = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
  const now = new Date().toISOString();
  const subId = uuidv4();
  await db.insert(subscriptions).values({
    id: subId,
    userId: null,
    clientId: input.clientId,
    planId: input.planId,
    status: "active",
    openmeterSubscriptionId: input.openmeterSubscriptionId,
    openmeterCustomerKey: customerKey,
    externalUserId: input.externalUserId,
    stripeCheckoutSessionId: null,
    createdAt: now,
  });
  return subId;
}

export async function ensureStarterSubscriptionForAppUser(input: {
  clientId: string;
  externalUserId: string;
}): Promise<{
  subscriptionId: string | null;
  openmeterSubscriptionId: string | null;
  planId: string;
  created: boolean;
}> {
  if (!isHostedAdminClientAvailable()) {
    const starter = await getOrCreateStarterPlan(input.clientId);
    return {
      subscriptionId: null,
      openmeterSubscriptionId: null,
      planId: starter.id,
      created: false,
    };
  }

  const existingRows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clientId, input.clientId),
        eq(subscriptions.externalUserId, input.externalUserId),
        inArray(subscriptions.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
      ),
    )
    .limit(1);

  const starter = await ensureStarterPlanSynced(input.clientId);
  if (!starter.openmeterPlanId) {
    throw new Error("Starter plan is not synced to OpenMeter");
  }

  if (existingRows[0]) {
    return {
      subscriptionId: existingRows[0].id,
      openmeterSubscriptionId: existingRows[0].openmeterSubscriptionId ?? null,
      planId: existingRows[0].planId,
      created: false,
    };
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
  const existingOm = await findOpenMeterStarterSubscription(client, customer.id, planKey);
  if (existingOm) {
    const subscriptionId = await persistStarterSubscriptionRow({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      planId: starter.id,
      openmeterSubscriptionId: existingOm.id,
    });
    return {
      subscriptionId,
      openmeterSubscriptionId: existingOm.id,
      planId: starter.id,
      created: true,
    };
  }

  let openmeterSubscriptionId: string | null = null;
  try {
    const omSubscription = await client.subscriptions.create({
      customerId: customer.id,
      plan: { key: planKey },
    });
    if (!omSubscription?.id) {
      throw new Error("Failed to create OpenMeter Starter subscription");
    }
    openmeterSubscriptionId = omSubscription.id;
  } catch (err) {
    if (!isOpenMeterConflictError(err)) {
      throw err;
    }

    const reconciled = await findOpenMeterStarterSubscription(client, customer.id, planKey);
    if (reconciled) {
      openmeterSubscriptionId = reconciled.id;
    }
    // Legacy trial provisioning may have created a metered entitlement without a
    // subscription row. Treat 409 as already provisioned and record Starter locally.
  }

  const subscriptionId = await persistStarterSubscriptionRow({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    planId: starter.id,
    openmeterSubscriptionId,
  });

  return {
    subscriptionId,
    openmeterSubscriptionId,
    planId: starter.id,
    created: true,
  };
}
