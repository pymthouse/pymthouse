import { db } from "@/db/index";
import { endUsers, transactions } from "@/db/schema";
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
        ? (err as { code: unknown }).code
        : undefined;
    const isUniqueViolation =
      msg.includes("unique") ||
      msg.includes("duplicate") ||
      code === "23505";
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
