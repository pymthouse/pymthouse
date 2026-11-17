import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db/index";
import {
  plans,
  signerConfig,
  subscriptions,
  usageBillingEvents,
  usageRecords,
} from "@/db/schema";

export async function getPlatformCutPercent() {
  const rows = await db
    .select({ defaultCutPercent: signerConfig.defaultCutPercent })
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  return rows[0]?.defaultCutPercent ?? null;
}

export async function getOwnerActiveSubscription(appId: string, ownerId: string) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clientId, appId),
        eq(subscriptions.userId, ownerId),
        eq(subscriptions.status, "active"),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPlanById(planId: string) {
  const rows = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  return rows[0] ?? null;
}

export async function getLatestActivePlanForApp(appId: string) {
  const rows = await db
    .select()
    .from(plans)
    .where(and(eq(plans.clientId, appId), eq(plans.status, "active")))
    .orderBy(desc(plans.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listUsageRecordsForBillingPeriod(params: {
  appId: string;
  periodStart: string;
  periodEnd: string;
}) {
  return db
    .select()
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.clientId, params.appId),
        gte(usageRecords.createdAt, params.periodStart),
        lte(usageRecords.createdAt, params.periodEnd),
      ),
    );
}

export async function listUsageBillingEventsForUsageRecords(params: {
  appId: string;
  usageRecordIds: string[];
}) {
  if (params.usageRecordIds.length === 0) return [];
  return db
    .select()
    .from(usageBillingEvents)
    .where(
      and(
        eq(usageBillingEvents.clientId, params.appId),
        inArray(usageBillingEvents.usageRecordId, params.usageRecordIds),
      ),
    );
}
