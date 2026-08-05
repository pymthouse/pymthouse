import {
  konnectAdminFetch,
  konnectMeteringV1Fetch,
} from "./konnect-admin-client";

export type SubscriptionChangeTiming = "immediate" | "next_billing_cycle";

export type KonnectSubscription = {
  id: string;
  status: string;
  customer_id: string;
  customerId?: string;
  plan_id?: string;
  planId?: string;
  settlement_mode?: string;
  billing_anchor?: string | Date | null;
  billingAnchor?: string | Date | null;
  /** When the subscription period starts (ISO), when Konnect provides it. */
  activeFrom?: string | Date | null;
  active_from?: string | Date | null;
  start?: string | Date | null;
};

export function konnectSubscriptionStartIso(
  sub: KonnectSubscription | null | undefined,
): string | null {
  if (!sub) return null;
  const raw = sub.activeFrom ?? sub.active_from ?? sub.start ?? null;
  if (!raw) return null;
  if (raw instanceof Date) return raw.toISOString();
  const trimmed = String(raw).trim();
  return trimmed || null;
}

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
 * Delete a scheduled subscription (OpenMeter: only `scheduled` may be deleted).
 * Uses Konnect `/metering/v1` — `/v3/openmeter` returns 405 for DELETE.
 */
export async function deleteKonnectSubscription(input: {
  subscriptionId: string;
}): Promise<void> {
  await konnectMeteringV1Fetch<unknown>(
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    { method: "DELETE" },
    "subscription-delete",
  );
}

/**
 * Continue a canceled subscription and delete conflicting scheduled successors.
 * Cloud UI uses `POST /metering/v1/subscriptions/{id}/restore` (not `/v3/openmeter`).
 * Prefer {@link unscheduleKonnectSubscriptionCancelation} for cancel-at-period-end
 * with no scheduled successor.
 */
export async function restoreKonnectSubscription(input: {
  subscriptionId: string;
}): Promise<KonnectSubscription> {
  return konnectMeteringV1Fetch<KonnectSubscription>(
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}/restore`,
    { method: "POST" },
    "subscription-restore",
  );
}

/**
 * Undo a `cancel` scheduled for `next_billing_cycle` (Konnect-supported).
 * Fails with 409 when a scheduled successor from `/change` still exists.
 */
export async function unscheduleKonnectSubscriptionCancelation(input: {
  subscriptionId: string;
}): Promise<KonnectSubscription> {
  return konnectAdminFetch<KonnectSubscription>(
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}/unschedule-cancelation`,
    { method: "POST", body: "{}" },
    "subscription-unschedule-cancelation",
  );
}

/** Billing-anchor ISO from a Konnect subscription row, when present. */
export function konnectSubscriptionBillingAnchorIso(
  sub: KonnectSubscription | null | undefined,
): string | null {
  if (!sub) return null;
  const raw = sub.billingAnchor ?? sub.billing_anchor ?? null;
  if (!raw) return null;
  if (raw instanceof Date) return raw.toISOString();
  const trimmed = String(raw).trim();
  return trimmed || null;
}

/** Estimate next cycle start as billing_anchor + 1 calendar month (UTC). */
export function estimateNextBillingCycleIso(
  billingAnchorIso: string | null | undefined,
): string | null {
  if (!billingAnchorIso?.trim()) return null;
  const anchor = new Date(billingAnchorIso);
  if (Number.isNaN(anchor.getTime())) return null;
  const targetMonth = anchor.getUTCMonth() + 1;
  const targetYear = anchor.getUTCFullYear() + Math.floor(targetMonth / 12);
  const monthIndex = targetMonth % 12;
  const lastDayOfMonth = new Date(
    Date.UTC(targetYear, monthIndex + 1, 0),
  ).getUTCDate();
  const day = Math.min(anchor.getUTCDate(), lastDayOfMonth);
  return new Date(
    Date.UTC(
      targetYear,
      monthIndex,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  ).toISOString();
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
