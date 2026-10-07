import { v4 as uuidv4 } from "uuid";
import { calendarMonthBoundsUtc } from "@/shared/utils/billing-utils";
import {
  cancelSubscription,
  createSubscriptionIfMissing,
  getActiveSubscriptionForUserAndClient,
  getPlanById,
  getUserSubscriptionById,
  listSubscriptionsForUser,
} from "../repo/subscriptions";

export async function listUserSubscriptions(userId: string) {
  return listSubscriptionsForUser(userId);
}

export async function createUserSubscription(userId: string, planId: string) {
  const plan = await getPlanById(planId);
  if (!plan) {
    return { ok: false as const, status: 404, body: { error: "Plan not found" } };
  }

  const existing = await getActiveSubscriptionForUserAndClient(userId, plan.clientId);
  if (existing) {
    return { ok: true as const, status: 200, body: existing };
  }

  const cal = calendarMonthBoundsUtc(new Date());
  const subscription = {
    id: uuidv4(),
    userId,
    clientId: plan.clientId,
    planId,
    status: "active" as const,
    currentPeriodStart: cal.start,
    currentPeriodEnd: cal.end,
    createdAt: cal.start,
    cancelledAt: null,
  };

  const result = await createSubscriptionIfMissing({ subscription });
  return {
    ok: true as const,
    status: result.isNew ? 201 : 200,
    body: result.row,
  };
}

export async function cancelUserSubscription(userId: string, subscriptionId: string) {
  const existing = await getUserSubscriptionById(subscriptionId, userId);
  if (!existing) {
    return {
      ok: false as const,
      status: 404,
      body: { error: "Subscription not found" },
    };
  }

  await cancelSubscription(subscriptionId, userId, new Date().toISOString());
  return { ok: true as const, status: 200, body: { success: true } };
}
