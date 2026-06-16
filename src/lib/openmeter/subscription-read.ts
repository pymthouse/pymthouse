import type { OpenMeter } from "@openmeter/sdk";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { ensureOpenMeterCustomerForAppUser } from "./customers";
import { buildOpenMeterPlanKey } from "./plan-naming";

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

type OpenMeterSubscriptionSourceItem = {
  id: string;
  status: string;
  plan?: { key?: string; id?: string } | null;
  planId?: string;
  plan_id?: string;
  planKey?: string | null;
  plan_key?: string | null;
  activeFrom?: Date | string | null;
  activeTo?: Date | string | null;
  active_from?: Date | string | null;
  active_to?: Date | string | null;
};

function readPlanFields(item: OpenMeterSubscriptionSourceItem): {
  planKey: string | null;
  planId: string | null;
} {
  const plan =
    item.plan && typeof item.plan === "object"
      ? item.plan
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

function mapSubscriptionItem(item: OpenMeterSubscriptionSourceItem): OpenMeterSubscriptionView {
  const { planKey, planId } = readPlanFields(item);
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

function readActiveFromTimestamp(
  subscription: Pick<OpenMeterSubscriptionView, "activeFrom">,
): number {
  const value = subscription.activeFrom;
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function compareSubscriptionsByActiveFromDesc(
  a: OpenMeterSubscriptionView,
  b: OpenMeterSubscriptionView,
): number {
  const byActiveFrom = readActiveFromTimestamp(b) - readActiveFromTimestamp(a);
  if (byActiveFrom !== 0) {
    return byActiveFrom;
  }
  return a.id.localeCompare(b.id);
}

function pickPrimarySubscription(
  subscriptions: OpenMeterSubscriptionView[],
): OpenMeterSubscriptionView | null {
  if (subscriptions.length === 0) {
    return null;
  }
  return [...subscriptions].sort(compareSubscriptionsByActiveFromDesc)[0];
}

function isStarterOpenMeterSubscription(
  subscription: OpenMeterSubscriptionView,
  starterPlanKey: string,
  starterOpenMeterPlanId: string | null,
): boolean {
  if (subscription.planKey === starterPlanKey) {
    return true;
  }
  if (starterOpenMeterPlanId && subscription.planId === starterOpenMeterPlanId) {
    return true;
  }
  return false;
}

export async function resolveLocalPlanIdFromOpenMeterSubscription(
  clientId: string,
  subscription: Pick<OpenMeterSubscriptionView, "planKey" | "planId">,
): Promise<string | null> {
  if (subscription.planId) {
    const byOpenMeterPlanId = await db
      .select({ id: plans.id })
      .from(plans)
      .where(
        and(eq(plans.clientId, clientId), eq(plans.openmeterPlanId, subscription.planId)),
      )
      .limit(1);
    if (byOpenMeterPlanId[0]?.id) {
      return byOpenMeterPlanId[0].id;
    }
  }

  if (!subscription.planKey) {
    return null;
  }

  const clientPlans = await db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.clientId, clientId));

  for (const plan of clientPlans) {
    if (buildOpenMeterPlanKey(clientId, plan.id) === subscription.planKey) {
      return plan.id;
    }
  }

  return null;
}

/** Prefer an active paid plan subscription over the app starter plan when both exist. */
export async function getPrimaryOpenMeterSubscriptionForAppUser(input: {
  clientId: string;
  externalUserId: string;
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
  const starterPlanKey = buildOpenMeterPlanKey(input.clientId, starter.id);

  const active = (await listOpenMeterSubscriptionsForCustomer(client, customer.id)).filter(
    (item) => isOpenMeterSubscriptionActive(item.status),
  );
  if (active.length === 0) {
    return null;
  }

  const paid = active.filter(
    (item) => !isStarterOpenMeterSubscription(item, starterPlanKey, starter.openmeterPlanId),
  );
  const primaryPaid = pickPrimarySubscription(paid);
  if (primaryPaid) {
    return primaryPaid;
  }

  const starters = active.filter((item) =>
    isStarterOpenMeterSubscription(item, starterPlanKey, starter.openmeterPlanId),
  );
  return pickPrimarySubscription(starters) ?? pickPrimarySubscription(active);
}

export function isOpenMeterSubscriptionActive(status: string): boolean {
  return OPENMETER_SUBSCRIPTION_ACTIVE_STATUSES.has(status);
}

export { buildOpenMeterCustomerKey } from "./customer-key";
