import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db/index";
import { appUsers, endUsers, usageBillingEvents, usageRecords } from "@/db/schema";

export async function listUsageRecords(params: {
  appId: string;
  startDate: string | null;
  endDate: string | null;
  filterUserId: string | null;
}) {
  const conditions = [eq(usageRecords.clientId, params.appId)];
  if (params.startDate) conditions.push(gte(usageRecords.createdAt, params.startDate));
  if (params.endDate) conditions.push(lte(usageRecords.createdAt, params.endDate));
  if (params.filterUserId) conditions.push(eq(usageRecords.userId, params.filterUserId));
  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

  return db.select().from(usageRecords).where(whereClause!);
}

export async function listUsageBillingEvents(params: {
  appId: string;
  usageRecordIds: string[];
  gatewayRequestId: string | null;
}) {
  if (params.usageRecordIds.length === 0) return [];
  return db
    .select()
    .from(usageBillingEvents)
    .where(
      and(
        eq(usageBillingEvents.clientId, params.appId),
        params.gatewayRequestId
          ? eq(usageBillingEvents.gatewayRequestId, params.gatewayRequestId)
          : undefined,
        inArray(usageBillingEvents.usageRecordId, params.usageRecordIds),
      ),
    );
}

export async function listAppUsersByIds(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(appUsers).where(inArray(appUsers.id, ids));
}

export async function listAppUsersByExternalIds(externalIds: string[]) {
  if (externalIds.length === 0) return [];
  return db.select().from(appUsers).where(inArray(appUsers.externalUserId, externalIds));
}

export async function listEndUsersByIds(appId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select({ id: endUsers.id, externalUserId: endUsers.externalUserId })
    .from(endUsers)
    .where(and(eq(endUsers.appId, appId), inArray(endUsers.id, ids)));
}

export async function listEndUsersByExternalIds(appId: string, externalIds: string[]) {
  if (externalIds.length === 0) return [];
  return db
    .select({ id: endUsers.id, externalUserId: endUsers.externalUserId })
    .from(endUsers)
    .where(and(eq(endUsers.appId, appId), inArray(endUsers.externalUserId, externalIds)));
}
