import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";

export async function listSubscriptionsForUser(userId: string) {
  return db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
}

export async function getPlanById(planId: string) {
  const rows = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  return rows[0] ?? null;
}

export async function getActiveSubscriptionForUserAndClient(userId: string, clientId: string) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.clientId, clientId),
        eq(subscriptions.status, "active"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createSubscriptionIfMissing(params: {
  subscription: {
    id: string;
    userId: string;
    clientId: string;
    planId: string;
    status: "active";
    currentPeriodStart: string;
    currentPeriodEnd: string;
    createdAt: string;
    cancelledAt: null;
  };
}) {
  return db.transaction(async (tx) => {
    const recheck = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, params.subscription.userId),
          eq(subscriptions.clientId, params.subscription.clientId),
          eq(subscriptions.status, "active"),
        ),
      )
      .limit(1);
    if (recheck[0]) {
      return { row: recheck[0], isNew: false };
    }
    await tx.insert(subscriptions).values(params.subscription);
    return { row: params.subscription, isNew: true };
  });
}

export async function getUserSubscriptionById(subscriptionId: string, userId: string) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function cancelSubscription(subscriptionId: string, userId: string, cancelledAt: string) {
  await db
    .update(subscriptions)
    .set({
      status: "cancelled",
      cancelledAt,
    })
    .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)));
}
