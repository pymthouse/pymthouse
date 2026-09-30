import { eq, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { endUsers, sessions, streamSessions, transactions, users } from "@/db/schema";

export async function listAdminUsers() {
  return db.select().from(users);
}

export async function listEndUsers() {
  return db.select().from(endUsers);
}

export async function getEndUserById(id: string) {
  const rows = await db.select().from(endUsers).where(eq(endUsers.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listEndUserSessions(endUserId: string) {
  return db.select().from(sessions).where(eq(sessions.endUserId, endUserId));
}

export async function listEndUserStreams(endUserId: string) {
  return db.select().from(streamSessions).where(eq(streamSessions.endUserId, endUserId));
}

export async function countEndUserTransactions(endUserId: string) {
  const [row] = await db
    .select({
      transactionCount: sql<number>`cast(count(${transactions.id}) as integer)`.mapWith(Number),
    })
    .from(transactions)
    .where(eq(transactions.endUserId, endUserId));

  return row?.transactionCount ?? 0;
}

export async function listEndUserTransactions(endUserId: string) {
  return db
    .select({
      id: transactions.id,
      type: transactions.type,
      amountWei: transactions.amountWei,
      platformCutPercent: transactions.platformCutPercent,
      platformCutWei: transactions.platformCutWei,
      txHash: transactions.txHash,
      status: transactions.status,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .where(eq(transactions.endUserId, endUserId));
}
