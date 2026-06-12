import type { OpenMeter } from "@openmeter/sdk";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { ensureOpenMeterCustomerForAppUser } from "./customers";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { buildOpenMeterPlanKey } from "./plans-sync";

const OPENMETER_SUBSCRIPTION_ACTIVE_STATUSES = new Set([
  "active",
  "scheduled",
  "pending",
]);

export type OpenMeterSubscriptionView = {
  id: string;
  status: string;
  planKey: string | null;
  planId: string | null;
  activeFrom: string | null;
  activeTo: string | null;
};

function readPlanFields(item: Record<string, unknown>): {
  planKey: string | null;
  planId: string | null;
} {
  const plan =
    item.plan && typeof item.plan === "object"
      ? (item.plan as Record<string, unknown>)
      : null;
  const planId =
    (typeof plan?.id === "string" ? plan.id : null) ??
    (typeof item.planId === "string" ? item.planId : null) ??
    (typeof item.plan_id === "string" ? item.plan_id : null);
  const planKey =
    (typeof plan?.key === "string" ? plan.key : null) ??
    (typeof item.planKey === "string" ? item.planKey : null) ??
    (typeof item.plan_key === "string" ? item.plan_key : null);
  return {
    planKey: planKey?.trim() || null,
    planId: planId?.trim() || null,
  };
}

function mapSubscriptionItem(item: {
  id: string;
  status: string;
  plan?: { key?: string; id?: string } | null;
  planId?: string;
  plan_id?: string;
  activeFrom?: Date | string | null;
  activeTo?: Date | string | null;
  active_from?: Date | string | null;
  active_to?: Date | string | null;
}): OpenMeterSubscriptionView {
  const { planKey, planId } = readPlanFields(item as Record<string, unknown>);
  const activeFrom = item.activeFrom ?? item.active_from ?? null;
  const activeTo = item.activeTo ?? item.active_to ?? null;

  return {
    id: item.id,
    status: item.status,
    planKey,
    planId,
    activeFrom:
      activeFrom instanceof Date ? activeFrom.toISOString() : activeFrom ?? null,
    activeTo: activeTo instanceof Date ? activeTo.toISOString() : activeTo ?? null,
  };
}

async function resolveOpenMeterPlanKey(
  client: OpenMeter,
  planId: string,
): Promise<string | null> {
  try {
    const plan = await client.plans.get(planId);
    return plan?.key?.trim() || null;
  } catch {
    return null;
  }
}

async function subscriptionMatchesPlan(
  client: OpenMeter,
  item: OpenMeterSubscriptionView,
  planKey: string,
  openmeterPlanId?: string | null,
): Promise<boolean> {
  if (item.planKey === planKey) {
    return true;
  }
  if (openmeterPlanId && item.planId === openmeterPlanId) {
    return true;
  }
  if (item.planId) {
    const resolvedKey = await resolveOpenMeterPlanKey(client, item.planId);
    if (resolvedKey === planKey) {
      return true;
    }
  }
  return false;
}

export async function verifyOpenMeterSubscriptionId(
  client: OpenMeter,
  subscriptionId: string,
): Promise<OpenMeterSubscriptionView | null> {
  try {
    const sub = await client.subscriptions.get(subscriptionId);
    if (!sub?.id) {
      return null;
    }
    return mapSubscriptionItem(sub);
  } catch {
    return null;
  }
}

export async function listOpenMeterSubscriptionsForCustomer(
  client: OpenMeter,
  customerId: string,
): Promise<OpenMeterSubscriptionView[]> {
  const listed = await client.customers.listSubscriptions(customerId, { pageSize: 100 });
  return (listed?.items ?? []).map((item) => mapSubscriptionItem(item));
}

export async function findOpenMeterSubscriptionByPlanKey(
  client: OpenMeter,
  customerId: string,
  planKey: string,
  input?: { openmeterPlanId?: string | null },
): Promise<OpenMeterSubscriptionView | null> {
  for (const item of await listOpenMeterSubscriptionsForCustomer(client, customerId)) {
    if (!(await subscriptionMatchesPlan(client, item, planKey, input?.openmeterPlanId))) {
      continue;
    }
    if (!OPENMETER_SUBSCRIPTION_ACTIVE_STATUSES.has(item.status)) {
      continue;
    }
    return item;
  }
  return null;
}

export async function getOpenMeterSubscriptionForAppUser(input: {
  clientId: string;
  externalUserId: string;
  planKey?: string;
}): Promise<OpenMeterSubscriptionView | null> {
  if (!isHostedAdminClientAvailable()) {
    return null;
  }

  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

  const starter = await getOrCreateStarterPlan(input.clientId);
  const planKey = input.planKey ?? buildOpenMeterPlanKey(input.clientId, starter.id);

  return findOpenMeterSubscriptionByPlanKey(client, customer.id, planKey, {
    openmeterPlanId: starter.openmeterPlanId,
  });
}

export function isOpenMeterSubscriptionActive(status: string): boolean {
  return OPENMETER_SUBSCRIPTION_ACTIVE_STATUSES.has(status);
}

export { buildOpenMeterCustomerKey };
