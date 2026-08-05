import { konnectAdminFetch } from "./konnect-admin-client";

export type SubscriptionChangeTiming = "immediate" | "next_billing_cycle";

export type KonnectSubscription = {
  id: string;
  status: string;
  customer_id: string;
  customerId?: string;
  plan_id?: string;
  planId?: string;
  settlement_mode?: string;
};

export type KonnectSubscriptionChangeResult = {
  current?: KonnectSubscription;
  next?: KonnectSubscription;
};

export function parseSubscriptionTiming(value: string): SubscriptionChangeTiming {
  if (value !== "immediate" && value !== "next_billing_cycle") {
    throw new Error("timing must be immediate or next_billing_cycle");
  }
  return value;
}

/**
 * Close a running Konnect subscription and start a new one on a different plan.
 * Used for upgrades, downgrades, and forced plan migrations.
 */
export async function changeKonnectSubscription(input: {
  subscriptionId: string;
  customerId: string;
  planId: string;
  timing: SubscriptionChangeTiming;
}): Promise<KonnectSubscriptionChangeResult> {
  return konnectAdminFetch<KonnectSubscriptionChangeResult>(
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}/change`,
    {
      method: "POST",
      body: JSON.stringify({
        customer: { id: input.customerId },
        plan: { id: input.planId },
        timing: input.timing,
      }),
    },
    "subscription-change",
  );
}

export async function cancelKonnectSubscription(input: {
  subscriptionId: string;
  timing?: SubscriptionChangeTiming;
}): Promise<KonnectSubscription> {
  return konnectAdminFetch<KonnectSubscription>(
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({
        timing: input.timing ?? "next_billing_cycle",
      }),
    },
    "subscription-cancel",
  );
}

/**
 * Continue a subscription and delete conflicting scheduled successors.
 * Used to undo a next-cycle plan change (e.g. scheduled Starter downgrade).
 */
export async function restoreKonnectSubscription(input: {
  subscriptionId: string;
}): Promise<KonnectSubscription> {
  return konnectAdminFetch<KonnectSubscription>(
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}/restore`,
    { method: "POST" },
    "subscription-restore",
  );
}

export async function listActiveKonnectSubscriptions(): Promise<
  KonnectSubscription[]
> {
  const out: KonnectSubscription[] = [];
  let page = 1;
  for (;;) {
    const body = await konnectAdminFetch<{
      data?: KonnectSubscription[];
      meta?: { page?: { size?: number; number?: number; total?: number } };
    }>(`/subscriptions?page=${page}&pageSize=100`, { method: "GET" }, "subscriptions");
    const items = body.data ?? [];
    for (const item of items) {
      if (item.status === "active" || item.status === "scheduled") {
        out.push({
          ...item,
          customer_id:
            item.customer_id?.trim() ||
            item.customerId?.trim() ||
            "",
        });
      }
    }
    const pageSize = body.meta?.page?.size ?? items.length;
    const total = body.meta?.page?.total;
    if (items.length === 0) {
      break;
    }
    if (typeof total === "number" && page * pageSize >= total) {
      break;
    }
    if (typeof total !== "number" && items.length < pageSize) {
      break;
    }
    page += 1;
  }
  return out;
}

export function subscriptionMatchesOpenMeterPlanId(
  subscription: KonnectSubscription,
  openmeterPlanId: string,
): boolean {
  const planId =
    subscription.plan_id?.trim() || subscription.planId?.trim() || "";
  return planId === openmeterPlanId;
}

export async function countActiveKonnectSubscriptionsForPlan(
  openmeterPlanId: string,
): Promise<number> {
  if (!openmeterPlanId.trim()) {
    return 0;
  }
  const active = await listActiveKonnectSubscriptions();
  return active.filter((item) =>
    subscriptionMatchesOpenMeterPlanId(item, openmeterPlanId),
  ).length;
}
