import { db } from "@/db/index";
import { endUsers, transactions } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

export async function hasEnoughCredits(
  endUserId: string,
  requiredWei: bigint,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(endUsers)
    .where(eq(endUsers.id, endUserId))
    .limit(1);
  const user = rows[0];
  if (!user) return false;
  return BigInt(user.creditBalanceWei) >= requiredWei;
}

export async function deductCredits(
  endUserId: string,
  amountWei: bigint,
): Promise<boolean> {
  if (amountWei < 0n) {
    throw new RangeError("amountWei must be a non-negative bigint");
  }
  const updated = await db
    .update(endUsers)
    .set({
      creditBalanceWei:
        sql`(((${endUsers.creditBalanceWei})::numeric - ${amountWei.toString()}::numeric)::text)`,
    })
    .where(
      and(
        eq(endUsers.id, endUserId),
        sql`(${endUsers.creditBalanceWei})::numeric >= ${amountWei.toString()}::numeric`,
      ),
    )
    .returning({ id: endUsers.id });

  return updated.length > 0;
}

export async function addCredits(
  endUserId: string,
  amountWei: bigint,
): Promise<void> {
  if (amountWei < 0n) {
    throw new RangeError("amountWei must be a non-negative bigint");
  }
  await db
    .update(endUsers)
    .set({
      creditBalanceWei:
        sql`(((COALESCE(${endUsers.creditBalanceWei}, '0'))::numeric + ${amountWei.toString()}::numeric)::text)`,
    })
    .where(eq(endUsers.id, endUserId));
}

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
      creditBalanceWei: "0",
    });
    return { id, isNew: true };
  } catch (err) {
    // Handle unique constraint violation (concurrent insert race)
    const msg = err instanceof Error ? err.message : String(err);
    const isUniqueViolation =
      msg.includes("unique") ||
      msg.includes("duplicate") ||
      (err as Record<string, unknown>).code === "23505";
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
