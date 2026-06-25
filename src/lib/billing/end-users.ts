import { db } from "@/db/index";
import { endUsers, transactions } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { normalizeWalletAddress } from "@/lib/turnkey";

export type AppEndUserOptions = {
  walletAddress?: string;
  turnkeySubOrgId?: string;
  turnkeyUserId?: string;
};

export async function findOrCreateAppEndUser(
  appId: string,
  externalUserId: string,
  options?: AppEndUserOptions,
): Promise<{ id: string; isNew: boolean }> {
  const normalizedWallet = normalizeWalletAddress(options?.walletAddress);
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
    const patch: Partial<typeof endUsers.$inferInsert> = {};
    if (normalizedWallet && normalizedWallet !== existing.walletAddress) {
      patch.walletAddress = normalizedWallet;
    }
    if (
      options?.turnkeySubOrgId &&
      options.turnkeySubOrgId !== existing.turnkeySubOrgId
    ) {
      patch.turnkeySubOrgId = options.turnkeySubOrgId;
    }
    if (
      options?.turnkeyUserId &&
      options.turnkeyUserId !== existing.turnkeyUserId
    ) {
      patch.turnkeyUserId = options.turnkeyUserId;
    }
    if (Object.keys(patch).length > 0) {
      await db.update(endUsers).set(patch).where(eq(endUsers.id, existing.id));
    }
    return { id: existing.id, isNew: false };
  }

  const id = uuidv4();
  try {
    await db.insert(endUsers).values({
      id,
      appId,
      externalUserId,
      walletAddress: normalizedWallet,
      turnkeySubOrgId: options?.turnkeySubOrgId || null,
      turnkeyUserId: options?.turnkeyUserId || null,
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
