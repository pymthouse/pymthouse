import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { apiKeys, subscriptions } from "@/db/schema";

export async function listAppKeys(appId: string) {
  return db
    .select({
      id: apiKeys.id,
      clientId: apiKeys.clientId,
      userId: apiKeys.userId,
      subscriptionId: apiKeys.subscriptionId,
      label: apiKeys.label,
      status: apiKeys.status,
      createdAt: apiKeys.createdAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.clientId, appId));
}

export async function getSubscriptionForApp(subscriptionId: string, appId: string) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.clientId, appId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createAppKeyRecord(record: typeof apiKeys.$inferInsert) {
  await db.insert(apiKeys).values(record);
}

export async function revokeAppKey(keyId: string, appId: string, revokedAt: string) {
  return db
    .update(apiKeys)
    .set({
      status: "revoked",
      revokedAt,
    })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.clientId, appId)))
    .returning({ id: apiKeys.id });
}
