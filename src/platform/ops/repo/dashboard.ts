import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { endUsers, signerConfig, transactions } from "@/db/schema";

export async function getDefaultSignerSnapshot() {
  const rows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  return rows[0] ?? null;
}

export async function listTransactionFeeRows() {
  return db
    .select({
      amountWei: transactions.amountWei,
      platformCutWei: transactions.platformCutWei,
    })
    .from(transactions);
}

export async function listEndUsers() {
  return db.select().from(endUsers);
}
