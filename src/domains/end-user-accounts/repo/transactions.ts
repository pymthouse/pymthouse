import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { transactions } from "@/db/schema";

export async function listTransactions(params: {
  endUserId?: string;
  limit: number;
  offset: number;
}) {
  if (params.endUserId) {
    return db
      .select()
      .from(transactions)
      .where(eq(transactions.endUserId, params.endUserId))
      .limit(params.limit)
      .offset(params.offset);
  }

  return db.select().from(transactions).limit(params.limit).offset(params.offset);
}
