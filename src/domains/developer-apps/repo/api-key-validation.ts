import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { apiKeys, planCapabilityBundles, plans, subscriptions } from "@/db/schema";

export async function getApiKeyByHash(keyHash: string) {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  return rows[0] ?? null;
}

export async function getSubscriptionForApiKey(subscriptionId: string, clientId: string) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.clientId, clientId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPlanForSubscription(planId: string) {
  const rows = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  return rows[0] ?? null;
}

export async function listCapabilitiesForPlan(planId: string) {
  return db
    .select()
    .from(planCapabilityBundles)
    .where(eq(planCapabilityBundles.planId, planId));
}
