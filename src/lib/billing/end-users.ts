import { db } from "@/db/index";
import { endUsers, transactions } from "@/db/schema";
import { parseEndUserCustomerKey } from "@/lib/openmeter/customer-key";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

export async function findOrCreateAppEndUser(
  appId: string,
  externalUserId: string,
): Promise<{ id: string; isNew: boolean }> {
  const existingRows = await db
    .select()
    .from(endUsers)
    .where(
      and(
        eq(endUsers.appId, appId),
        eq(endUsers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  const existing = existingRows[0];

  if (existing) {
    return { id: existing.id, isNew: false };
  }

  const id = uuidv4();
  try {
    await db.insert(endUsers).values({
      id,
      appId,
      externalUserId,
    });
    return { id, isNew: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as Record<string, unknown>).code
        : undefined;
    const isUniqueViolation =
      msg.includes("unique") ||
      msg.includes("duplicate") ||
      code === "23505" ||
      code === 23505;
    if (isUniqueViolation) {
      const retryRows = await db
        .select()
        .from(endUsers)
        .where(
          and(
            eq(endUsers.appId, appId),
            eq(endUsers.externalUserId, externalUserId),
          ),
        )
        .limit(1);
      if (retryRows[0]) return { id: retryRows[0].id, isNew: false };
    }
    throw err;
  }
}

/**
 * Map a canonical OpenMeter end-user key (`eu_{end_users.id}`) back to the
 * integrator `external_user_id` used by `app_users` prefs and Connect
 * customers. Non-`eu_` values pass through unchanged.
 */
export async function resolveAppUserExternalIdFromCustomerKey(
  externalUserId: string,
): Promise<string> {
  const trimmed = externalUserId.trim();
  const endUserRowId = parseEndUserCustomerKey(trimmed);
  if (!endUserRowId) {
    return trimmed;
  }
  try {
    const rows = await db
      .select({
        externalUserId: endUsers.externalUserId,
      })
      .from(endUsers)
      .where(eq(endUsers.id, endUserRowId))
      .limit(1);
    const resolved = rows[0]?.externalUserId?.trim();
    return resolved || trimmed;
  } catch {
    return trimmed;
  }
}

export async function getTransactions(
  endUserId?: string,
  limit: number = 50,
  offset: number = 0,
) {
  if (endUserId) {
    return db
      .select()
      .from(transactions)
      .where(eq(transactions.endUserId, endUserId))
      .limit(limit)
      .offset(offset);
  }

  return db.select().from(transactions).limit(limit).offset(offset);
}
