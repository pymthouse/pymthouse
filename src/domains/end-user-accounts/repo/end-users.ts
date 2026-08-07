import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { endUsers } from "@/db/schema";

export async function listEndUsers() {
  return db.select().from(endUsers);
}

export async function getEndUserById(endUserId: string) {
  const rows = await db.select().from(endUsers).where(eq(endUsers.id, endUserId)).limit(1);
  return rows[0] ?? null;
}

export async function getEndUserByTurnkeyUserId(turnkeyUserId: string) {
  const rows = await db
    .select()
    .from(endUsers)
    .where(eq(endUsers.turnkeyUserId, turnkeyUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateEndUserWalletAddress(endUserId: string, walletAddress: string) {
  await db.update(endUsers).set({ walletAddress }).where(eq(endUsers.id, endUserId));
}

export async function createEndUser(params: {
  id: string;
  turnkeyUserId?: string | null;
  walletAddress?: string | null;
  creditBalanceWei?: string;
  appId?: string | null;
  externalUserId?: string | null;
}) {
  await db.insert(endUsers).values({
    id: params.id,
    turnkeyUserId: params.turnkeyUserId ?? null,
    walletAddress: params.walletAddress ?? null,
    creditBalanceWei: params.creditBalanceWei ?? "0",
    appId: params.appId ?? null,
    externalUserId: params.externalUserId ?? null,
  });
}

export async function deductCredits(endUserId: string, amountWei: bigint): Promise<boolean> {
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

export async function addCredits(endUserId: string, amountWei: bigint) {
  await db
    .update(endUsers)
    .set({
      creditBalanceWei:
        sql`(((COALESCE(${endUsers.creditBalanceWei}, '0'))::numeric + ${amountWei.toString()}::numeric)::text)`,
    })
    .where(eq(endUsers.id, endUserId));
}
